// An adapter with a position arg (`space`): a connection that names one has a
// `Note` with a field of its own (`Title` in "alpha", `Heading` in "beta"); one
// that names none has no types. Every describe and every create is logged to
// calls.jsonl in its working folder with the space it was asked in, as the
// request's `settings` carry it. It is a polled source too: each poll of a
// space logs the checkpoint it was handed and returns one note of that space.
// Listens where listen-fire says (`MODULE_SOCKET`, else `PORT`).

import { createServer } from 'node:http';
import { appendFileSync, unlinkSync } from 'node:fs';

const FIELD = { alpha: 'Title', beta: 'Heading' };

const manifest = {
  protocolVersion: 2,
  adapterType: 'notes',
  supportedTriggers: ['poll'],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['manifest', 'listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord', 'poll'],
  poll: { intervalSeconds: 60 },
  webhookEventTypeId: 'Note',
  subscribableEvents: ['note.added'],
  credentials: [{ name: 'workspace', kind: 'static', fields: [{ name: 'workspace', secret: false }] }],
  positionArgs: [{ name: 'space', optionsFrom: 'Space', label: 'Space' }],
};

function answer(method, params, space) {
  const log = (entry) => appendFileSync('calls.jsonl', `${JSON.stringify({ method, space, ...entry })}\n`);
  switch (method) {
    case 'manifest':
      return manifest;
    case 'listEntryPoints':
      if (space === undefined) return [];
      return [{ typeId: 'Note', displayName: 'Note', writable: true, readable: false, fires: true }];
    case 'describe': {
      log({});
      const field = FIELD[space];
      if (field === undefined) throw new Error(`no space "${space}"`);
      return { typeId: 'Note', displayName: 'Note', fields: [{ fieldId: field, displayName: field, kind: 'string', writable: true, required: false }], references: [] };
    }
    case 'resolveEntity':
      return { candidates: [] };
    case 'createRecord':
      log({ fields: params.fields });
      return { adapterType: 'notes', externalId: `${space}-1`, recordType: 'Note', data: params.fields };
    case 'poll': {
      log({ checkpoint: params.checkpoint ?? null });
      const at = typeof params.checkpoint === 'number' ? params.checkpoint + 1 : 1;
      const id = `${space}-${at}`;
      return { events: [{ payload: { id, [FIELD[space]]: id }, externalId: id, idempotencyKey: id, eventType: 'note.added' }], checkpoint: at };
    }
    case 'getFieldValue':
      return params.position?.identity?.data?.[params.fieldId] ?? null;
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
      reply = { ok: true, result: answer(request.method, request.params ?? {}, request.settings?.space) };
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
