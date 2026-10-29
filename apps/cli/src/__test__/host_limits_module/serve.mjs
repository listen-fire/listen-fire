// An adapter that declares `hostLimits: true` and asks listen-fire's limits door
// before its "provider request" inside `describe`, as `@lf/mcp` does when it
// lists a server's tools. Each answer the door gives is logged to
// door.jsonl in its working folder. Listens where listen-fire says (`MODULE_SOCKET`,
// else `PORT`).

import { createServer } from 'node:http';
import { appendFileSync, unlinkSync } from 'node:fs';

const manifest = {
  protocolVersion: 2,
  adapterType: 'notes',
  supportedTriggers: [],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['manifest', 'listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord'],
  credentials: [{ name: 'workspace', kind: 'static', fields: [{ name: 'workspace', secret: false }] }],
  hostLimits: true,
};

/** Ask the door, as module-kit's `limitedFetch` does: acquire, then release. */
async function askDoor(door, method) {
  if (door === undefined) return;
  const ask = async (question) => {
    const response = await fetch(door.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${door.ticket}` },
      body: JSON.stringify(question),
    });
    const body = await response.json();
    appendFileSync('door.jsonl', `${JSON.stringify({ method, op: question.op, status: response.status, body })}\n`);
    if (!response.ok) throw new Error(`the limits door answered ${response.status}`);
    return body;
  };
  const grant = await ask({ op: 'acquire' });
  if (grant.outcome === 'granted') await ask({ op: 'release', permit: grant.permit });
}

async function answer(method, params, door) {
  switch (method) {
    case 'manifest':
      return manifest;
    case 'listEntryPoints':
      return [{ typeId: 'Note', displayName: 'Note', writable: true, readable: false }];
    case 'describe':
      await askDoor(door, method);
      return { typeId: 'Note', displayName: 'Note', fields: [{ fieldId: 'Title', displayName: 'Title', kind: 'string', writable: true, required: false }], references: [] };
    case 'resolveEntity':
      return { candidates: [] };
    case 'createRecord':
      await askDoor(door, method);
      return { adapterType: 'notes', externalId: 'note-1', recordType: 'Note', data: params.fields };
    case 'getFieldValue':
      return null;
    case 'getRelated':
      return [];
    default:
      throw new Error(`${method} is not served`);
  }
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    const request = JSON.parse(body);
    let reply;
    try {
      reply = { ok: true, result: await answer(request.method, request.params ?? {}, request.hostLimits) };
    } catch (error) {
      reply = { ok: false, error: { code: 'adapter_error', message: error.message, retryable: false } };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
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
