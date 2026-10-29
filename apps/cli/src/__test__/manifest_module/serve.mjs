// A module that answers every request with the manifest in `manifest.json`
// beside it (read from its working folder): enough for a host to read its
// manifest and refuse it. Listens where listen-fire says (`MODULE_SOCKET`, else `PORT`).

import { createServer } from 'node:http';
import { readFileSync, unlinkSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, result: manifest }));
  });
});
const socket = process.env.MODULE_SOCKET || undefined;
if (socket !== undefined) {
  try {
    unlinkSync(socket);
  } catch {
    // No stale socket.
  }
  server.listen(socket, () => process.stdout.write(`listening unix:${socket}\n`));
} else {
  server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => process.stdout.write(`listening ${server.address().port}\n`));
}
