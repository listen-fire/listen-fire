// An adapter with each kind of edge an address walks, its answers fixed:
// `Channel`'s `Posts` only written off a record, `Archive` only written off the
// connection but landing on a type with readable fields, `approve` and `notify`
// only written off the connection and landing on types known only by what is
// written to them, one with edges and one with none. Listens where listen-fire
// says (`MODULE_SOCKET`, else `PORT`).

import { createServer } from 'node:http';
import { unlinkSync } from 'node:fs';

const manifest = {
  protocolVersion: 2,
  adapterType: 'places',
  supportedTriggers: [],
  runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
  methods: ['manifest', 'listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'deleteRecord'],
};

const string = (name, more = {}) => ({ fieldId: name, displayName: name, kind: 'string', writable: false, required: false, ...more });
const edge = (name, target, more = {}) => ({ fieldId: name, name, targetTypeId: target, cardinality: 'many', direction: 'outgoing', ...more });

const entryPoints = [
  { typeId: 'Channel', displayName: 'Channel', writable: false, readable: true, collectionName: 'Channels' },
  { typeId: 'Post', displayName: 'Post', writable: true, readable: false },
  { typeId: 'Linked User', displayName: 'Linked User', writable: false, readable: false },
  { typeId: 'Archived', displayName: 'Archived', writable: true, readable: false, collectionName: 'Archive' },
  { typeId: 'Approval', displayName: 'Approval', writable: true, readable: false, collectionName: 'approve' },
  { typeId: 'Notice', displayName: 'Notice', writable: true, readable: false, collectionName: 'notify' },
  { typeId: 'Press', displayName: 'Press', writable: false, readable: false },
];

const types = {
  Channel: {
    description: 'A place people talk.',
    fields: [string('Name', { description: 'What it is called.' }), string('Secret Name')],
    references: [
      edge('Posts', 'Post', { readable: false, writable: true, description: 'Post into it.' }),
      edge('Linked Users', 'Linked User'),
      edge('Pings', 'Press', { readable: false, listenable: true, identity: 'Label' }),
      edge('Archives', 'Archived'),
    ],
  },
  Post: {
    description: 'A post in a channel.',
    fields: [string('Text', { writable: true, required: true, description: 'What it says.' }), string('Reply Markup', { kind: 'json', writable: true, readable: false }), string('Id')],
    references: [edge('Reactions', 'Press')],
  },
  'Linked User': { fields: [string('Email')], references: [] },
  Archived: { fields: [string('Kept', { writable: true })], references: [edge('Owner', 'Linked User')] },
  Approval: {
    description: 'Ask a person to approve: the template reads "Hello {{Customer}}, approve {{Amount}}?".',
    fields: [
      string('Customer', { writable: true, description: "Who it is for: the template's first placeholder." }),
      { fieldId: 'Amount', displayName: 'Amount', kind: 'enum', enumValues: ['low', 'high'], writable: true, required: true, description: 'How much is asked.' },
    ],
    references: [edge('Presses', 'Press', { readable: false, listenable: true, identity: 'Label', description: 'Each button pressed.' })],
  },
  Notice: { fields: [string('Words', { writable: true, required: true })], references: [] },
  Press: { description: 'One button pressed.', fields: [string('Label', { description: 'The button.' })], references: [] },
};

function answer(method, params) {
  switch (method) {
    case 'manifest':
      return manifest;
    case 'listEntryPoints':
      return entryPoints;
    case 'describe':
      return { typeId: params.typeId, displayName: params.typeId, ...types[params.typeId] };
    case 'resolveEntity':
      return { candidates: [] };
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
      reply = { ok: true, result: answer(request.method, request.params ?? {}) };
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
