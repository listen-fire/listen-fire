// The response cache evicts on a timer; a host process that used the client
// must still exit when its work is done, not minutes later.

import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

describe('the Slack response cache', () => {
  it('does not keep the event loop alive', () => {
    const script = `
      const http = require('node:http');
      const { getSlackClient } = require(${JSON.stringify(resolve(__dirname, '../api_client.ts'))});
      const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"ok":true,"channel":{"id":"C1"}}'); });
      server.listen(0, '127.0.0.1', async () => {
        const client = getSlackClient('xoxb-1', 'http://127.0.0.1:' + server.address().port + '/');
        await client.api.conversations.info({ channel: 'C1' });
        server.close();
        server.closeAllConnections();
      });
    `;
    const started = Date.now();
    const run = spawnSync(process.execPath, ['--require', require.resolve('tsx/cjs'), '-e', script], { timeout: 20_000, encoding: 'utf8' });
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});
