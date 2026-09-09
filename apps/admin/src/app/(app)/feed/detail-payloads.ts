/**
 * The shapes an ops event's payload actually arrives in, recognised structurally.
 *
 * `detail` crosses tRPC as JSON with no discriminator, and the emit sites are
 * spread across the API, so the feed reads the payload's shape rather than a
 * tag. Detection lives apart from the renderers so it stays pure.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// ─── Detail payloads ──────────────────────────────────────────────────

export type DetailShape =
  | { kind: 'none' }
  | { kind: 'slack'; text: string; blocks: unknown }
  | {
      kind: 'feedback';
      goal: string;
      friction: string;
      reporterEmail: string | null;
      source: string | null;
    }
  | {
      kind: 'milestone';
      milestone: string;
      userId: string | null;
      teamId: string | null;
      tool: string | null;
    }
  | { kind: 'unknown'; value: unknown };

export function detectDetailKind(detail: unknown): DetailShape {
  if (detail == null) return { kind: 'none' };
  if (!isRecord(detail)) return { kind: 'unknown', value: detail };

  if (typeof detail.text === 'string') {
    return { kind: 'slack', text: detail.text, blocks: detail.blocks ?? null };
  }
  if (typeof detail.goal === 'string' && typeof detail.friction === 'string') {
    return {
      kind: 'feedback',
      goal: detail.goal,
      friction: detail.friction,
      reporterEmail: optionalString(detail.reporterEmail),
      source: optionalString(detail.source),
    };
  }
  if (typeof detail.milestone === 'string') {
    return {
      kind: 'milestone',
      milestone: detail.milestone,
      userId: optionalString(detail.userId),
      teamId: optionalString(detail.teamId),
      tool: optionalString(detail.tool),
    };
  }
  return { kind: 'unknown', value: detail };
}

// ─── Error titles ─────────────────────────────────────────────────────

/**
 * Run failures land in the feed as a bare thrown-error string in `title` with
 * no detail at all — e.g. `Attio Error: 409 (Conflict): {"code":…}`. Split the
 * human prefix from the JSON tail so the page can show a sentence and inspect
 * the payload, instead of one truncated blob.
 */
export type ErrorTitle = { headline: string; payload: Record<string, unknown> };

export function parseErrorTitle(title: string): ErrorTitle | null {
  for (let open = title.indexOf('{'); open !== -1; open = title.indexOf('{', open + 1)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(title.slice(open));
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;
    const headline = title.slice(0, open).replace(/[\s:—-]+$/, '');
    // A title that is nothing but JSON has no sentence to promote; leave it to
    // the generic path rather than heading the page with an empty string.
    if (headline.length === 0) return null;
    return { headline, payload: parsed };
  }
  return null;
}

/** One-line form for the feed list, where the row has a single truncated line. */
export function summarizeErrorTitle({ headline, payload }: ErrorTitle): string {
  const message = optionalString(payload.message);
  return message ? `${headline} — ${message}` : headline;
}

/** camelCase / snake_case key → spaced words; the label styling uppercases. */
export function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
}

/** Identifiers, codes and enum-ish strings read better in mono than in prose. */
export function looksLikeCode(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  return /^[\w.:/@-]+$/.test(value);
}
