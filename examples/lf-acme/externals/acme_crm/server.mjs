// Acme CRM: a sample external speaking adapter protocol 2, with no
// dependencies — a port of the dev loop's fake CRM (lf-platform's apps/api/src/scripts/dev/
// fake_crm_adapter.ts) as a plain process, so it shows an external can be any
// program that answers the protocol over HTTP.
//
// One record type, `Company { Name, Description }`, and two events a listen
// may choose, `company.created` and `company.updated`; a webhook delivers
// created companies as `{ companies: [{ id, Name }] }`. A movement can wait on
// two edges of a company (adapter protocol 2.5):
//
// - its comment thread (`Comments`, to `Comment { Id, Text }`), which can be
//   listed too, oldest first: `await company-[:Comments]->` takes the first
//   comment already there, or else the next to arrive;
// - its approvals (`Approvals`, to `Approval { id, Decision }`), which are
//   only ever announced, never listed.
//
// Each edge of a company is waited on under a key (`awaitKeys`): `thread:<id>`
// and `approvals:<id>`. What lands on it is reported as an arrival on that key,
// named by its id; a company deleted is a gone arrival on both. A webhook
// delivery may carry comments too (`comments: [{ id, thread, text }]`): each is
// reported as an arrival. Companies, comments and approvals are kept in the
// file named by ACME_CRM_STATE, so a test (or a developer) can see a write land.
//
// The CRM also owns an inbound side of its own, the way a hosted system
// would: the `/dev/…` routes change its state and push the change to the
// host's doors (`emit`, `wake` under LF_HOST_URL, which `listen-fire serve`
// hands the externals it starts), presenting the credential the host calls it
// with.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const port = Number(process.env.PORT ?? 0);
const statePath = process.env.ACME_CRM_STATE;

const hostUrl = process.env.LF_HOST_URL;

const COMPANY = 'Company';
const COMMENT = 'Comment';
const COMMENTS_EDGE = 'Comments';
const APPROVAL = 'Approval';
const APPROVALS_EDGE = 'Approvals';
const COMPANY_CREATED = 'company.created';
const COMPANY_UPDATED = 'company.updated';

function readState() {
  const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
  return { companies: state.companies ?? [], comments: state.comments ?? [], approvals: state.approvals ?? [] };
}

const threadKey = (company) => `thread:${company}`;
const approvalsKey = (company) => `approvals:${company}`;
const EDGE_KEYS = { [COMMENTS_EDGE]: threadKey, [APPROVALS_EDGE]: approvalsKey };

/** A company the CRM holds and has not deleted. */
const holds = (state, company) => state.companies.some((c) => c.externalId === company && !c.deleted);

/** A comment as the record it is: what the thread lists and what arrives. */
const commentLanding = (comment) => ({ recordId: comment.id, recordType: COMMENT, fields: { Id: comment.id, Text: comment.Text } });

/** A comment as an arrival on its thread's `Comments`. */
function commentArrival(comment) {
  return {
    edge: COMMENTS_EDGE,
    key: threadKey(comment.thread),
    identity: comment.id,
    landing: commentLanding(comment),
  };
}

/** An approval as an arrival on its company's `Approvals`. */
function approvalArrival(approval) {
  return {
    edge: APPROVALS_EDGE,
    key: approvalsKey(approval.company),
    identity: approval.id,
    landing: { recordId: approval.id, recordType: APPROVAL, fields: { id: approval.id, Decision: approval.Decision } },
  };
}

function writeState(state) {
  if (statePath) writeFileSync(statePath, JSON.stringify(state, null, 2));
}

const COMPANY_DESCRIPTOR = {
  typeId: COMPANY,
  displayName: COMPANY,
  deletable: true,
  fields: [
    { fieldId: 'Name', displayName: 'Name', kind: 'string', writable: true, required: true },
    { fieldId: 'Description', displayName: 'Description', kind: 'string', writable: true, required: false },
    { fieldId: 'Report', displayName: 'Report', kind: 'file', writable: true, required: false },
  ],
  references: [
    {
      fieldId: COMMENTS_EDGE,
      name: COMMENTS_EDGE,
      targetTypeId: COMMENT,
      cardinality: 'many',
      direction: 'outgoing',
      // People comment in the CRM; nothing is created along the thread.
      writable: false,
      // Listenable: the CRM reports each comment as it lands, so a wait is
      // woken, not polled. A comment's `Id` names it; the thread lists oldest first.
      listenable: true,
      identity: 'Id',
      sequenced: 'chronological',
      // A company the CRM deletes settles its waits empty rather than leaving them forever.
      resolvesEmpty: true,
    },
    {
      fieldId: APPROVALS_EDGE,
      name: APPROVALS_EDGE,
      targetTypeId: APPROVAL,
      cardinality: 'many',
      direction: 'outgoing',
      writable: false,
      // Announced as each decision is made, never listed.
      readable: false,
      listenable: true,
      identity: 'id',
      resolvesEmpty: true,
    },
  ],
};

const APPROVAL_DESCRIPTOR = {
  typeId: APPROVAL,
  displayName: APPROVAL,
  fields: [
    { fieldId: 'id', displayName: 'id', kind: 'string', writable: false, required: false },
    { fieldId: 'Decision', displayName: 'Decision', kind: 'string', writable: false, required: false },
  ],
  references: [],
};

const COMMENT_DESCRIPTOR = {
  typeId: COMMENT,
  displayName: COMMENT,
  fields: [
    // The CRM's id for the comment: what names one arrival on a thread.
    { fieldId: 'Id', displayName: 'Id', kind: 'string', writable: false, required: false },
    { fieldId: 'Text', displayName: 'Text', kind: 'string', writable: false, required: false },
  ],
  references: [],
};

function companyCreatedEvent(company) {
  return {
    payload: company,
    externalId: company.id,
    tag: COMPANY_CREATED,
    eventType: COMPANY_CREATED,
    changeType: 'create',
    recordType: COMPANY,
  };
}

const METHODS = {
  manifest: () => ({
    protocolVersion: 2,
    adapterType: 'acme_crm',
    supportedTriggers: ['webhook'],
    // What a listen on this CRM may say: `events: [...]` from this list.
    subscribableEvents: [COMPANY_CREATED, COMPANY_UPDATED],
    runtimeCapabilities: { traversal: { incoming: false, edgeProperties: false }, resources: false },
    methods: Object.keys(METHODS).filter((m) => m !== 'manifest'),
  }),
  listEntryPoints: () => [
    {
      typeId: COMPANY,
      displayName: COMPANY,
      scope: 'self-configured',
      writable: true,
      readable: false,
      fires: true,
      description: 'A company. A listen is delivered each one somebody creates in the CRM.',
    },
    // Reached only along a company's edges; published so they are named.
    { typeId: COMMENT, displayName: COMMENT, scope: 'self-configured', writable: false, readable: false },
    { typeId: APPROVAL, displayName: APPROVAL, scope: 'self-configured', writable: false, readable: false },
  ],
  describe: ({ typeId }) => ({ [COMPANY]: COMPANY_DESCRIPTOR, [COMMENT]: COMMENT_DESCRIPTOR, [APPROVAL]: APPROVAL_DESCRIPTOR })[typeId] ?? null,
  resolveEntity: () => ({ candidates: [] }),
  getFieldValue: ({ position, fieldId }) => {
    const data = position?.identity?.data;
    return data && typeof data === 'object' ? (data[fieldId] ?? null) : null;
  },
  // A company's thread, oldest first; nothing else is listed.
  getRelated: ({ position, fieldId }) => {
    if (fieldId !== COMMENTS_EDGE) return [];
    const company = position?.identity?.recordId;
    return readState()
      .comments.filter((c) => c.thread === company)
      .map((c) => ({ position: { adapterType: 'acme_crm', recordType: COMMENT, identity: { kind: 'stable', recordId: c.id, data: { Id: c.id, Text: c.Text } } } }));
  },
  createRecord: async ({ recordType, fields: written }) => {
    const fields = await withFileContents(written);
    const state = readState();
    const externalId = `company-${state.companies.length + 1}`;
    state.companies.push({ externalId, fields });
    writeState(state);
    // A comment armed for the next write lands on the company while the
    // write is still in flight: reported before this call answers.
    if (commentOnNextWrite !== undefined) {
      const text = commentOnNextWrite;
      commentOnNextWrite = undefined;
      await addComment(externalId, text);
    }
    return { adapterType: 'acme_crm', externalId, recordType, data: { ...fields } };
  },
  updateRecord: ({ externalId, recordType, fields }) => {
    const state = readState();
    const existing = state.companies.find((c) => c.externalId === externalId);
    if (!existing) return { notFound: true };
    existing.fields = { ...existing.fields, ...fields };
    writeState(state);
    return { adapterType: 'acme_crm', externalId, recordType, data: { ...existing.fields } };
  },
  // A delivery's companies are its events; its comments, the arrivals it
  // reports: only those it carries, each named by its own id.
  preprocessInbound: ({ raw }) => ({
    events: (raw?.companies ?? []).map(companyCreatedEvent),
    arrivals: (raw?.comments ?? []).map(({ id, thread, text }) => commentArrival({ id, thread, Text: text })),
  }),
  listEventTypes: () => [
    { tag: COMPANY_CREATED, positionType: COMPANY },
    { tag: COMPANY_UPDATED, positionType: COMPANY },
  ],
  // The key each company's edge is waited on under; a company the CRM no
  // longer holds is gone, and nothing more arrives on it.
  awaitKeys: ({ edge, heads }) => {
    const keyOf = EDGE_KEYS[edge];
    if (!keyOf) throw new Error(`'${edge}' is not a listenable edge (only ${Object.keys(EDGE_KEYS).join(', ')})`);
    const state = readState();
    return heads.map(({ recordId }) => (holds(state, recordId) ? { key: keyOf(recordId) } : { gone: true }));
  },
};

// The comment `/dev/comment-on-next-write` armed for the next company written.
let commentOnNextWrite;

/** A comment on `company`'s thread, kept and reported as its arrival. */
async function addComment(company, text) {
  const state = readState();
  const comment = { id: `comment-${state.comments.length + 1}`, thread: company, Text: text };
  state.comments.push(comment);
  writeState(state);
  const arrived = await push('wake', { arrivals: [commentArrival(comment)] });
  return { id: comment.id, arrived };
}

// The credential the host calls with: the one this install holds, which a
// push to the host's doors presents back.
let hostCredential;

/** Push to one of the host's doors. */
async function push(door, body) {
  if (!hostUrl) throw new Error('LF_HOST_URL is not set: start this external under `listen-fire serve`');
  if (!hostCredential) throw new Error('the host has not called yet, so there is no credential to present');
  const response = await fetch(new URL(`/api/public/adapter/acme_crm/${door}`, hostUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: hostCredential },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

// A user changes the CRM itself; the CRM tells the host.
const DEV_ROUTES = {
  '/dev/companies': async (body) => {
    if (typeof body?.Name !== 'string') return [400, { error: 'expected { Name }' }];
    const state = readState();
    const externalId = `company-${state.companies.length + 1}`;
    state.companies.push({ externalId, fields: { Name: body.Name } });
    writeState(state);
    const pushed = await push('emit', { events: [companyCreatedEvent({ id: externalId, Name: body.Name })] });
    return [200, { id: externalId, pushed }];
  },
  '/dev/comments': async (body) => {
    if (typeof body?.company !== 'string' || typeof body?.text !== 'string') return [400, { error: 'expected { company, text }' }];
    return [200, await addComment(body.company, body.text)];
  },
  // The next company written gets this comment while its write is in flight.
  '/dev/comment-on-next-write': async (body) => {
    if (typeof body?.text !== 'string') return [400, { error: 'expected { text }' }];
    commentOnNextWrite = body.text;
    return [200, { armed: body.text }];
  },
  // A decision on a company, and with `also` a second one: both reported in
  // one push, in that order.
  '/dev/approvals': async (body) => {
    if (typeof body?.company !== 'string' || typeof body?.decision !== 'string') return [400, { error: 'expected { company, decision, also? }' }];
    const state = readState();
    const decisions = [body.decision, ...(typeof body.also === 'string' ? [body.also] : [])];
    const approvals = decisions.map((Decision, i) => ({ id: `approval-${state.approvals.length + i + 1}`, company: body.company, Decision }));
    state.approvals.push(...approvals);
    writeState(state);
    const arrived = await push('wake', { arrivals: approvals.map(approvalArrival) });
    return [200, { ids: approvals.map((a) => a.id), arrived }];
  },
  // A company deleted: every wait on its edges settles empty.
  '/dev/companies/delete': async (body) => {
    if (typeof body?.company !== 'string') return [400, { error: 'expected { company }' }];
    const state = readState();
    const company = state.companies.find((c) => c.externalId === body.company && !c.deleted);
    if (!company) return [404, { error: `no company ${body.company}` }];
    company.deleted = true;
    writeState(state);
    const arrived = await push('wake', { arrivals: Object.entries(EDGE_KEYS).map(([edge, keyOf]) => ({ edge, key: keyOf(body.company), gone: true })) });
    return [200, { deleted: body.company, arrived }];
  },
};

// A file arrives as a descriptor whose bytes the host exposed at a URL (they
// cannot ride the JSON envelope): fetch them, and keep their text.
async function withFileContents(fields) {
  const out = {};
  for (const [name, value] of Object.entries(fields ?? {})) {
    if (value && typeof value === 'object' && value.__brand === 'FileRef' && typeof value.url === 'string') {
      const res = await fetch(value.url);
      out[name] = { name: value.name ?? null, contentType: value.contentType ?? null, text: await res.text() };
    } else out[name] = value;
  }
  return out;
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', async () => {
    if (req.method === 'GET' && req.url === '/dev/state') return send(res, 200, readState());
    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    const dev = DEV_ROUTES[req.url ?? ''];
    if (dev) {
      try {
        const [status, answer] = await dev(body ? JSON.parse(body) : {});
        return send(res, status, answer);
      } catch (error) {
        return send(res, 500, { error: String(error?.message ?? error) });
      }
    }
    // The host hands the install's credential on every call; this CRM only
    // asks that one is there.
    if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) {
      return send(res, 200, { ok: false, error: { code: 'unauthorized', message: 'no credential', retryable: false } });
    }
    hostCredential = req.headers.authorization;
    try {
      const { method, params } = JSON.parse(body);
      const handler = METHODS[method];
      if (!handler) {
        return send(res, 200, { ok: false, error: { code: 'method_not_found', message: method, retryable: false } });
      }
      send(res, 200, { ok: true, result: await handler(params ?? {}) });
    } catch (error) {
      send(res, 200, { ok: false, error: { code: 'internal', message: String(error?.message ?? error), retryable: false } });
    }
  });
});

server.listen(port, '127.0.0.1', () => {
  // The host reads the bound port from this line; a developer (or a test)
  // driving the dev routes reads it beside the state file.
  const bound = server.address().port;
  if (statePath) writeFileSync(join(dirname(statePath), 'port'), String(bound));
  process.stdout.write(`listening ${bound}\n`);
});
