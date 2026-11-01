// A GitHub-like feed of notifications: a root `Notifications` it announces
// arrivals on, each with the `Reason` it was sent for. Its 0.12 listens named
// the reasons in the settings form; its manifest declares how such a listen
// becomes a traversal (`listenSettingsBecome`), so `listen-fire upgrade`
// rewrites one. Listens where listen-fire says (`MODULE_SOCKET`, else `PORT`).

import { createServer } from 'node:http';
import { unlinkSync } from 'node:fs';

const manifest = {
  protocolVersion: 2,
  adapterType: 'alerts',
  supportedTriggers: ['webhook'],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['manifest', 'listEntryPoints', 'describe', 'getFieldValue', 'getRelated'],
  listenSettingsBecome: {
    path: ['Notifications'],
    aliases: ['n'],
    paramFrom: 'Notification',
    keys: { events: { hop: 0, field: 'Reason', op: 'in' } },
  },
};

const NOTIFICATION = {
  typeId: 'Notification',
  displayName: 'Notification',
  fields: [
    { fieldId: 'Id', displayName: 'Id', kind: 'string', writable: false, required: true },
    { fieldId: 'Reason', displayName: 'Reason', kind: 'string', writable: false, required: true },
    { fieldId: 'Title', displayName: 'Title', kind: 'string', writable: false, required: false },
  ],
  references: [],
};

function answer(method) {
  switch (method) {
    case 'manifest':
      return manifest;
    case 'listEntryPoints':
      return [
        {
          typeId: 'Notification',
          displayName: 'Notification',
          collectionName: 'Notifications',
          writable: false,
          readable: false,
          listenable: true,
          identity: 'Id',
          delivery: 'connection',
        },
      ];
    case 'describe':
      return NOTIFICATION;
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
      reply = { ok: true, result: answer(request.method) };
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
