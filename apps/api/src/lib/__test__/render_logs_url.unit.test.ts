// The Render service id is the host's, not ours. An install that is not on
// Render must get NO link — a dashboard URL with an empty id would 404 into
// somebody else's account rather than say "there are no logs here".

import { renderLogsUrl } from '../render_logs_url';

describe('renderLogsUrl', () => {
  const original = process.env.RENDER_SERVICE_ID;
  afterEach(() => {
    if (original === undefined) delete process.env.RENDER_SERVICE_ID;
    else process.env.RENDER_SERVICE_ID = original;
  });

  it('deeplinks to the service Render injected, filtered to the request', () => {
    process.env.RENDER_SERVICE_ID = 'srv-test1234';
    expect(renderLogsUrl('req-abc')).toBe(
      'https://dashboard.render.com/web/srv-test1234/logs?q=req-abc',
    );
  });

  it('is null when the deployment is not on Render', () => {
    delete process.env.RENDER_SERVICE_ID;
    expect(renderLogsUrl('req-abc')).toBeNull();
  });

  it('treats a blank id as unset', () => {
    process.env.RENDER_SERVICE_ID = '   ';
    expect(renderLogsUrl('req-abc')).toBeNull();
  });
});
