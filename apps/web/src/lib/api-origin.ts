/**
 * The origin the browser sends API calls to.
 *
 * A self-host image is built with NO baked origin: the Next server proxies
 * `/api/*` to whatever `API_INTERNAL_URL` names at RUN time, so the browser
 * only ever needs same-origin. `||` rather than `??` on purpose — a build that
 * sets the variable to the empty string means "unset", and `new URL(path, '')`
 * throws.
 */
export function apiOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL ||
    (typeof window !== 'undefined' ? window.location.origin : '')
  );
}
