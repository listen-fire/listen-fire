// An adapter whose schema depends on the connection: its one credential names
// a workspace, and each workspace's `Note` has a field of its own (`Title` in
// "alpha", `Heading` in "beta"). Every describe and every create is logged to
// calls.jsonl in its working folder with the workspace it was asked as.
// Listens where listen-fire says (`MODULE_SOCKET`, else `PORT`).

import { createServer } from 'node:http';
import { appendFileSync, unlinkSync } from 'node:fs';

const FIELD = { alpha: 'Title', beta: 'Heading' };

const manifest = {
  protocolVersion: 2,
  adapterType: 'notes',
  supportedTriggers: [],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['manifest', 'listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord'],
  credentials: [{ name: 'workspace', kind: 'static', fields: [{ name: 'workspace', secret: false }] }],
};

function answer(method, params, workspace) {
  const log = (entry) => appendFileSync('calls.jsonl', `${JSON.stringify({ method, workspace, ...entry })}\n`);
  switch (method) {
    case 'manifest':
      return manifest;
    case 'listEntryPoints':
      return [{ typeId: 'Note', displayName: 'Note', writable: true, readable: false }];
    case 'describe': {
      log({});
      const field = FIELD[workspace];
      if (field === undefined) throw new Error(`no workspace "${workspace}"`);
      return { typeId: 'Note', displayName: 'Note', fields: [{ fieldId: field, displayName: field, kind: 'string', writable: true, required: false }], references: [] };
    }
    case 'resolveEntity':
      return { candidates: [] };
    case 'createRecord':
      log({ fields: params.fields });
      return { adapterType: 'notes', externalId: `${workspace}-1`, recordType: 'Note', data: params.fields };
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
  req.on('end', () => {
    const request = JSON.parse(body);
    let reply;
    try {
      reply = { ok: true, result: answer(request.method, request.params ?? {}, request.credential?.fields?.workspace) };
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
