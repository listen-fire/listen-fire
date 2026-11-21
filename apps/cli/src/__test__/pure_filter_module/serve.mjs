// A module whose `Messages` carry their sender's email as a claim
// (`User Email`, branded `claim:email/address`): pushed to the host's wake
// door, as are a message's `Replies`, which a run may wait on, or posted to
// its webhook (`preprocessInbound` reads the `arrivals` posted). While a
// file `down` is beside it the module is out of reach: it will not start,
// and a webhook it is asked to read ends the process. While a file `refuse`
// is there it refuses to read a webhook. Listens where listen-fire says
// (`PORT`).

import { existsSync } from 'node:fs';
import { createServer } from 'node:http';

const DOWN = new URL('down', import.meta.url);
const REFUSE = new URL('refuse', import.meta.url);
if (existsSync(DOWN)) process.exit(1);

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
  preprocessInbound: ({ raw }) => {
    if (existsSync(DOWN)) process.exit(1);
    if (existsSync(REFUSE)) throw new Error('talk no longer reads this request');
    return { events: [], arrivals: raw.arrivals };
  },
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
