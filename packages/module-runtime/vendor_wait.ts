// How long a rate-limited vendor asked its caller to wait. Here, below both
// the engine and the module kit, so the kit's limits door and the engine's
// limiter (`throttleAfter`, movement-engine/public/limiter) read one parser.

const SECOND = 1000;

const MIN_WAIT_MS = 1 * SECOND;
const MAX_WAIT_MS = 120 * SECOND;

function clamp(ms: number): number {
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.round(ms)));
}

/** `Retry-After` is either whole seconds or an HTTP date. */
function fromHeaderValue(value: string, now: number): number | undefined {
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * SECOND;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : date - now;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined;
  if ('get' in headers && typeof headers.get === 'function') {
    const value: unknown = headers.get(name);
    return typeof value === 'string' ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === 'string') return value;
  }
  return undefined;
}

function field(value: unknown, name: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, name) : undefined;
}

/**
 * Google's `google.rpc.RetryInfo` detail: `"retryDelay": "17s"` (or
 * `"17.5s"`) on the wire, `{ seconds: 17 }` in a decoded form. The genai SDK's
 * `ApiError` carries the JSON body only as text in its message.
 */
function fromRetryInfo(text: string): number | undefined {
  const quoted = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text);
  if (quoted) return Number(quoted[1]) * SECOND;
  const object = /"retryDelay"\s*:\s*\{\s*"seconds"\s*:\s*"?(\d+)"?/.exec(text);
  return object ? Number(object[1]) * SECOND : undefined;
}

/**
 * How long the vendor asked a rate-limited caller to wait, or undefined when
 * it did not say. Read from `e.headers` (a plain object or `Headers`; a
 * `Response` is one) or `e.response.headers`, else Google's `RetryInfo` in an
 * error's message. Clamped to [1s, 120s] so a hostile or absurd value can
 * neither spin nor stall a caller.
 */
export function vendorWaitMs(e: unknown, now: number = Date.now()): number | undefined {
  const header = readHeader(field(e, 'headers'), 'retry-after') ?? readHeader(field(field(e, 'response'), 'headers'), 'retry-after');
  const fromHeader = header === undefined ? undefined : fromHeaderValue(header, now);
  if (fromHeader !== undefined) return clamp(fromHeader);

  const text = e instanceof Error ? e.message : undefined;
  const fromBody = text === undefined ? undefined : fromRetryInfo(text);
  return fromBody === undefined ? undefined : clamp(fromBody);
}

/** What a vendor reports of its own budget on a success. */
export interface VendorBudget {
  /** Calls (or tokens) the vendor says are left in its window. */
  remaining: number;
  /** Epoch ms when that window resets. */
  resetAt: number;
}

/** Each family of success headers: the remaining count, and when it resets. */
const BUDGET_FAMILIES = [
  { remaining: 'anthropic-ratelimit-requests-remaining', reset: 'anthropic-ratelimit-requests-reset' },
  { remaining: 'anthropic-ratelimit-tokens-remaining', reset: 'anthropic-ratelimit-tokens-reset' },
  { remaining: 'x-ratelimit-remaining-requests', reset: 'x-ratelimit-reset-requests' },
  { remaining: 'x-ratelimit-remaining-tokens', reset: 'x-ratelimit-reset-tokens' },
];

const DURATION_UNIT_MS: Record<string, number> = { ms: 1, s: SECOND, m: 60 * SECOND, h: 3600 * SECOND };

/** OpenAI's reset form: a Go-style duration, `"1s"`, `"6m0s"`, `"20ms"`. */
function fromDuration(text: string): number | undefined {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join('') !== text) return undefined;
  return parts.reduce((total, [, amount, unit]) => total + Number(amount) * (DURATION_UNIT_MS[unit] ?? 0), 0);
}

/** A reset as an epoch ms: an ISO timestamp (Anthropic), whole or fractional
 *  seconds from now, or a duration from now (OpenAI). */
function resetInstant(value: string, now: number): number | undefined {
  const text = value.trim();
  if (/^\d+(\.\d+)?$/.test(text)) return now + Number(text) * SECOND;
  const duration = fromDuration(text);
  if (duration !== undefined) return now + duration;
  const date = Date.parse(text);
  return Number.isNaN(date) ? undefined : date;
}

/**
 * The budget a vendor reported on a success, from its rate-limit headers
 * (`headers`: a plain object or `Headers`): Anthropic's
 * `anthropic-ratelimit-{requests,tokens}-{remaining,reset}` and OpenAI's
 * `x-ratelimit-{remaining,reset}-{requests,tokens}`. When several limits
 * report, the one that binds: an exhausted one (the latest reset among them),
 * else the least remaining. Undefined when no family gave both a count and a
 * reset. The reset is clamped to at most 120s ahead, as `vendorWaitMs` clamps
 * a wait.
 */
export function vendorBudget(headers: unknown, now: number = Date.now()): VendorBudget | undefined {
  const reports: VendorBudget[] = [];
  for (const family of BUDGET_FAMILIES) {
    const left = readHeader(headers, family.remaining)?.trim();
    const reset = readHeader(headers, family.reset);
    if (left === undefined || reset === undefined || !/^\d+$/.test(left)) continue;
    const resetAt = resetInstant(reset, now);
    if (resetAt === undefined) continue;
    reports.push({ remaining: Number(left), resetAt: Math.min(resetAt, now + MAX_WAIT_MS) });
  }
  const exhausted = reports.filter((report) => report.remaining === 0);
  if (exhausted.length > 0) return exhausted.reduce((latest, report) => (report.resetAt > latest.resetAt ? report : latest));
  return reports.reduce<VendorBudget | undefined>((least, report) => (least === undefined || report.remaining < least.remaining ? report : least), undefined);
}
