// This deployment's own public origin, as OAuth discovery documents need to
// name it (the resource URI, the metadata URLs). Three sources, in order of
// how much the operator actually chose them:
//
//   1. `PUBLIC_URL` — set explicitly for exactly this.
//   2. `API_BASE_URL` — already set on every deployment (the icon URL, the
//      capabilities probe's MCP URLs read it too), so a deployment that never
//      bothered with `PUBLIC_URL` still gets the right origin instead of
//      whatever a proxy's Host header happens to say.
//   3. The request's own Host header — the last resort for a deployment that
//      set neither, trusting `x-forwarded-*` the way the rest of the app does.
//
// One helper, not one copy per OAuth surface, so the three disagreeing would
// be a bug in one place instead of a drift between two.

function getOrigin(req: import('express').Request): string {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL;
  if (process.env.API_BASE_URL) return process.env.API_BASE_URL.replace(/\/$/, '');
  const host = req.get('x-forwarded-host') ?? req.get('host');
  const proto = req.get('x-forwarded-proto') ?? req.protocol;
  return `${proto}://${host}`;
}

export { getOrigin };
