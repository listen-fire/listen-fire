/**
 * Deeplink into this deployment's own Render logs, filtered to one request id.
 *
 * The service id belongs to the HOST, not to us: Render injects
 * `RENDER_SERVICE_ID` into every service it runs, so a Render deployment gets
 * the link for free, and an install anywhere else gets no link at all rather
 * than one pointing into a dashboard that is not theirs.
 */
function renderLogsUrl(requestId: string): string | null {
  const serviceId = process.env.RENDER_SERVICE_ID?.trim();
  if (!serviceId) return null;
  return `https://dashboard.render.com/web/${serviceId}/logs?q=${encodeURIComponent(requestId)}`;
}

export { renderLogsUrl };
