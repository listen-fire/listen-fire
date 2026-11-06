// A module that reports who acted: `Messages` is pushed, `Notes` is polled, a
// message's `Replies` are waited on. `config.json` in its
// working folder says what it lists and answers (`distinctTypeIds` gives each
// type an id that is not its display name, as a real module's are), and
// `polled.json` what a poll finds. Each `getActorCandidates` is logged to calls.jsonl. As a real module
// does, it refuses a field it never described: what a host adds to a landing is
// the host's to answer. Listens where listen-fire says (`PORT`).

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const config = () => JSON.parse(readFileSync('config.json', 'utf8'));
const polled = () => (existsSync('polled.json') ? JSON.parse(readFileSync('polled.json', 'utf8')) : []);

const MESSAGE = 'Message';
const NOTE = 'Note';
const field = (name) => ({ fieldId: name, displayName: name, kind: 'string', writable: false, required: false });

// A landing's `recordType` is its type's display name; the type is described and listed by its id.
const idOf = (name) => (config().distinctTypeIds === true ? `type:${name}` : name);
const nameOf = (typeId) => String(typeId).replace(/^type:/, '');

function describe(typeId) {
  const own = config().ownActorField === true ? [field('Actor')] : [];
  const name = nameOf(typeId);
  if (name === MESSAGE) {
    return {
      typeId: idOf(MESSAGE),
      displayName: MESSAGE,
      fields: [field('Id'), field('Text'), ...own],
      references: [{ fieldId: 'Replies', name: 'Replies', targetTypeId: idOf(MESSAGE), cardinality: 'many', direction: 'outgoing', readable: false, writable: false, listenable: true, identity: 'Id' }],
    };
  }
  if (name === NOTE) return { typeId: idOf(NOTE), displayName: NOTE, fields: [field('Id'), field('Text')], references: [] };
  return null;
}

const METHODS = {
  manifest: () => ({
    protocolVersion: 2,
    protocolMinor: 6,
    adapterType: 'people',
    supportedTriggers: ['webhook'],
    poll: { intervalSeconds: 60 },
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: [...Object.keys(METHODS).filter((m) => !['manifest', 'getActorCandidates', 'extractActor'].includes(m)), ...(config().lists ?? [])],
  }),
  listEntryPoints: () => [
    { typeId: idOf(MESSAGE), displayName: MESSAGE, collectionName: 'Messages', scope: 'self-configured', writable: false, readable: false, listenable: true, identity: 'Id', delivery: 'connection' },
    { typeId: idOf(NOTE), displayName: NOTE, collectionName: 'Notes', scope: 'self-configured', writable: false, readable: false, listenable: true, identity: 'Id', delivery: 'polled', pollEverySeconds: 60, cursor: true },
  ],
  describe: ({ typeId }) => describe(typeId),
  resolveEntity: () => ({ candidates: [] }),
  getFieldValue: ({ position, fieldId }) => {
    const declared = describe(position?.recordType ?? MESSAGE)?.fields.some((f) => f.fieldId === fieldId);
    if (!declared) throw new Error(`'${fieldId}' is not a known field of '${position?.recordType}'`);
    return position?.identity?.data?.[fieldId] ?? null;
  },
  getRelated: () => [],
  awaitKeys: ({ heads }) => heads.map(({ recordId }) => ({ key: `replies:${recordId}` })),
  poll: ({ cursor }) => ({ arrivals: cursor === undefined ? [] : polled(), cursor: 'read' }),
  getActorCandidates: ({ event }) => {
    appendFileSync('calls.jsonl', `${JSON.stringify({ method: 'getActorCandidates', actor: event?.arrival?.actor })}\n`);
    const { candidates, candidatesFail } = config();
    if (candidatesFail === true) throw new Error('the directory is down');
    return candidates ?? [];
  },
  extractActor: ({ event }) => event?.arrival?.actor ?? null,
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
