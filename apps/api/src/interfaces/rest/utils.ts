import { Request } from 'express';

function extractDistinctQueryParams<T extends string>(
  req: Request,
  keys: T[],
): { [K in T]: string } {
  const out: Partial<{ [K in T]: string }> = {};
  for (const key of keys) {
    const val = req.query[key];
    if (typeof val !== 'string') {
      throw new Error(`Missing or malformed query param "${key}"`);
    }
    out[key] = val;
  }
  return out as { [K in T]: string };
}

export { extractDistinctQueryParams };
