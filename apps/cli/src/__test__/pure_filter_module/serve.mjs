// A module whose `Messages` carry their sender's email as a claim
// (`User Email`, branded `claim:email/address`): pushed to the host's wake
// door, as are a message's `Replies`, which a run may wait on. Listens where
// listen-fire says (`PORT`).

import { createServer } from 'node:http';

const MESSAGE = 'Message';
const field = (name, more = {}) => ({ fieldId: name, displayName: name, kind: 'string', writable: false, required: false, ...more });

const message = {
  typeId: MESSAGE,
  displayName: MESSAGE,
  fields: [field('Id'), field('Name'), field('User Email', { brands: ['claim:email/address'] })],
  references: [{ fieldId: 'Replies', name: 'Replies', targetTypeId: MESSAGE, cardinality: 'many', direction: 'outgoing', readable: false, writable: false, listenable: true, identity: 'Id' }],
};

const METHODS = {
  manifest: () => ({
    protocolVersion: 2,
    protocolMinor: 6,
    adapterType: 'talk',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: Object.keys(METHODS),
  }),
  listEntryPoints: () => [{ typeId: MESSAGE, displayName: MESSAGE, collectionName: 'Messages', scope: 'self-configured', writable: false, readable: false, listenable: true, identity: 'Id', delivery: 'connection' }],
  describe: ({ typeId }) => (typeId === MESSAGE ? message : null),
  resolveEntity: () => ({ candidates: [] }),
  getFieldValue: ({ position, fieldId }) => position?.identity?.data?.[fieldId] ?? null,
  getRelated: () => [],
  awaitKeys: ({ heads }) => heads.map(({ recordId }) => ({ key: `replies:${recordId}` })),
};

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    let reply;
    try {
      const request = JSON.parse(body);
      const method = METHODS[request.method];
      if (method === undefined) throw new Error(`${request.method} is not served`);
      reply = { ok: true, result: method(request.params ?? {}) };
    } catch (error) {
      reply = { ok: false, error: { code: 'adapter_error', message: error.message, retryable: false } };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply));
  });
});
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => process.stdout.write(`listening ${server.address().port}\n`));
