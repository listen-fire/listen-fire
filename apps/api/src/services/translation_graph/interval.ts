// Postgres-style INTERVAL strings — "6 months", "1 year 3 months",
// "30 days", "1 hour 30 minutes". Used by the WITHIN clause inside
// uniqueness constraints to express temporal identity scopes. Shared
// between the translation agent (which validates intervals at author
// time) and adapters (which need to compute concrete cutoff dates when
// resolving identity at runtime).

const INTERVAL_UNITS: Record<
  string,
  { kind: 'months' | 'days' | 'seconds'; multiplier: number }
> = {
  year: { kind: 'months', multiplier: 12 },
  yr: { kind: 'months', multiplier: 12 },
  month: { kind: 'months', multiplier: 1 },
  mon: { kind: 'months', multiplier: 1 },
  week: { kind: 'days', multiplier: 7 },
  wk: { kind: 'days', multiplier: 7 },
  day: { kind: 'days', multiplier: 1 },
  hour: { kind: 'seconds', multiplier: 3600 },
  hr: { kind: 'seconds', multiplier: 3600 },
  minute: { kind: 'seconds', multiplier: 60 },
  min: { kind: 'seconds', multiplier: 60 },
  second: { kind: 'seconds', multiplier: 1 },
  sec: { kind: 'seconds', multiplier: 1 },
};

export interface ParsedInterval {
  months: number;
  days: number;
  seconds: number;
}

export function parseInterval(
  s: string,
): { ok: true; parsed: ParsedInterval } | { ok: false; error: string } {
  const parts = s.trim().toLowerCase().split(/\s+/);
  if (parts.length === 0 || parts.length % 2 !== 0) {
    return {
      ok: false,
      error: `Could not parse interval "${s}". Use "<n> <unit>" pairs, e.g. "6 months" or "1 year 3 months".`,
    };
  }
  const out: ParsedInterval = { months: 0, days: 0, seconds: 0 };
  for (let i = 0; i < parts.length; i += 2) {
    const n = Number(parts[i]);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return { ok: false, error: `Bad number "${parts[i]}" in interval "${s}".` };
    }
    const unit = parts[i + 1].replace(/s$/, '');
    const spec = INTERVAL_UNITS[unit];
    if (!spec) {
      return {
        ok: false,
        error: `Unknown unit "${parts[i + 1]}" in interval "${s}". Use year(s), month(s), week(s), day(s), hour(s), minute(s), or second(s).`,
      };
    }
    out[spec.kind] += n * spec.multiplier;
  }
  return { ok: true, parsed: out };
}

/** Subtract a ParsedInterval from a Date, returning a new Date. */
export function subtractInterval(from: Date, interval: ParsedInterval): Date {
  const result = new Date(from);
  if (interval.months > 0) result.setMonth(result.getMonth() - interval.months);
  if (interval.days > 0) result.setDate(result.getDate() - interval.days);
  if (interval.seconds > 0) result.setSeconds(result.getSeconds() - interval.seconds);
  return result;
}
