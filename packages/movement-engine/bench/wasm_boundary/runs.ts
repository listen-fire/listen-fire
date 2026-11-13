// The representative runs the boundary benchmark times: each a whole
// `runMovement` against in-process fakes (no network, no model), built as
// the engine's own run tests build theirs (services/movement_engine/__test__/
// rust_traverse.unit.test.ts): a mail trigger and a graph adapter whose
// records are rows.
//
//  - small:     a trigger and one write: the floor every run pays.
//  - walk:      a walk over 200 stored records, a field read per record and a
//               write for half of them: many small requests and answers.
//  - records:   one fetch that lands 2,000 records carrying their fields
//               inline, filtered and counted locally: one large answer.
//  - document:  a 256 KB non-ASCII document in the trigger, slugged
//               (`Text.slug` asks the environment services for NFKD) and
//               written: large payloads in every direction.

import { mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';
import { tenantIdOf } from 'engine-contracts';
import { makeStablePosition, makeUnstablePosition, META_RECORD_TYPE, positionData, positionRecordId } from 'engine-contracts/catalog';

import type { Adapter, GetRelatedInput, RelatedResult } from '../../services/translation_graph/adapter';
import { containerAssociation } from '../../services/translation_graph/adapter';
import type { TriggerEvent } from '../../services/translation_graph/triggers/types';
import type { RunMovementInput } from '../../public/movement-engine';
import { credentialIdsFor, makeTestHost } from '../../public/testing';

const TEAM_ID = tenantIdOf('00000000-0000-0000-0000-0000000000b7');

const emailSchema: InstanceSchema = {
  positions: { message: { properties: { subject: 'text', text: 'text' }, edges: {} } },
  collections: {},
  writableRoots: {},
};

const graphSchema: InstanceSchema = {
  positions: {
    company: { properties: { name: 'text', stage: 'text', revenue: 'number', city: 'text', sector: 'text', owner: 'text', note: 'text' }, edges: {} },
    note: { properties: { text: 'text' }, edges: {} },
  },
  collections: { company: { target: 'company' }, note: { target: 'note' } },
  writableRoots: { note: { fields: { text: 'text' }, resultShape: { externalId: 'text', text: 'text' } } },
};

const catalog = mockCatalogSnapshot({
  adapters: {
    email: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: emailSchema },
    graph: { constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }], schema: graphSchema },
  },
  credentials: { dealflow_inbox: { adapters: ['email'] }, graph_main: { adapters: ['graph'] } },
});

const PRELUDE = [
  'import { email, graph } from adapters',
  'import { dealflow_inbox, graph_main } from credentials',
  'inbox = connect email using dealflow_inbox',
  'kg    = connect graph using graph_main',
  '',
].join('\n');

const movement = (body: string): string => `${PRELUDE}function m(msg: <inbox-[:message]->>) {\n${body}\n}`;

/** A field of a position's inline data, null where it has none. */
function field(data: unknown, name: string): unknown {
  return typeof data === 'object' && data !== null ? (Reflect.get(data, name) ?? null) : null;
}

interface Row {
  id: string;
  fields: Record<string, unknown>;
}

interface GraphOptions {
  companies: Row[];
  /** Land each record with its fields inline (an unstable position), as a
   *  source that answers whole records does; otherwise by id, each field a
   *  read of its own. */
  inline: boolean;
}

/** A graph whose companies are rows, answering every write. */
function fakeGraph({ companies, inline }: GraphOptions): Adapter {
  const byId = new Map(companies.map((row) => [row.id, row]));
  const position = (row: Row) =>
    inline
      ? makeUnstablePosition({ adapterType: 'graph', recordType: 'company', data: row.fields })
      : makeStablePosition({ adapterType: 'graph', recordType: 'company', recordId: row.id });
  let written = 0;
  return {
    adapterType: 'graph',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      const id = positionRecordId(input.position);
      if (id !== undefined) return byId.get(id)?.fields[input.fieldId] ?? null;
      return field(positionData(input.position), input.fieldId);
    },
    async getRelated(read: GetRelatedInput): Promise<RelatedResult[]> {
      if (read.position.recordType !== META_RECORD_TYPE || read.fieldId !== 'company') return [];
      return companies.map((row) => ({ position: position(row) }));
    },
    async createRecord() {
      written += 1;
      return { adapterType: 'graph', externalId: `note-${written}`, data: {} };
    },
    async updateRecord(input) {
      return { adapterType: 'graph', externalId: input.externalId, data: {}, association: containerAssociation(input) };
    },
    deleteRecord: async () => ({}),
  };
}

function fakeEmail(): Adapter {
  return {
    adapterType: 'email',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    listEntryPoints: async () => [],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    async getFieldValue(input) {
      return field(positionData(input.position), input.fieldId);
    },
    getRelated: async () => [],
    createRecord: async () => ({ adapterType: 'email', externalId: 'x', data: {} }),
    updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
    deleteRecord: async () => ({}),
  };
}

function webhook(payload: Record<string, unknown>): TriggerEvent {
  return { pipelineInputId: 'pi-wasm-boundary-bench', adapterType: 'email', triggerType: 'webhook', payload };
}

/** Deterministic text: `words` words of 3–10 letters, `accent` of them
 *  carrying a diacritic, so the text is not ASCII. */
function prose(words: number, seed: number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  const out: string[] = [];
  for (let w = 0; w < words; w += 1) {
    const length = 3 + (next() % 8);
    let word = '';
    for (let i = 0; i < length; i += 1) word += letters[next() % letters.length];
    out.push(next() % 7 === 0 ? `${word}é` : word);
  }
  return out.join(' ');
}

const companies = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `co-${i}`,
    fields: {
      name: `Company ${i} ${prose(3, i)}`,
      stage: i % 2 === 0 ? 'Seed' : 'Late',
      revenue: (i * 7919) % 100_000,
      city: prose(2, i + 1),
      sector: prose(2, i + 2),
      owner: `owner-${i % 17}@example.com`,
      note: prose(12, i + 3),
    },
  }));

export interface BenchRun {
  name: string;
  why: string;
  /** How many writes a run that went as intended made. */
  writes: number;
  input: () => RunMovementInput;
}

function runInput(source: string, event: TriggerEvent, graph: GraphOptions): RunMovementInput {
  const adapters = { email: fakeEmail(), graph: fakeGraph(graph) };
  return {
    source,
    event,
    teamId: TEAM_ID,
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    firedAt: '2026-05-01T09:00:00.000Z',
    host: makeTestHost({
      adapters: {
        resolve: (request) => {
          if (request.adapterType === 'email') return adapters.email;
          if (request.adapterType === 'graph') return adapters.graph;
          throw new Error(`bench: no fake for ${request.adapterType}`);
        },
      },
    }),
  };
}

const WALKED = companies(200);
const LANDED = companies(2000);
const DOCUMENT = prose(36_000, 7);

export const RUNS: readonly BenchRun[] = [
  {
    name: 'small',
    why: 'a trigger and one write',
    writes: 1,
    input: () =>
      runInput(movement('  write kg-[:note]-> { text: msg.`subject` }'), webhook({ subject: 'Acme', text: 'hello' }), {
        companies: [],
        inline: false,
      }),
  },
  {
    name: 'walk',
    why: '200 stored records walked, two field reads each, 100 writes',
    writes: 100,
    input: () =>
      runInput(
        movement('  kg-[c:company]-> {\n    if (c.`stage` == "Seed") {\n      write kg-[:note]-> { text: c.`name` }\n    }\n  }'),
        webhook({ subject: 'Acme', text: 'hello' }),
        { companies: WALKED, inline: false },
      ),
  },
  {
    name: 'records',
    why: '2,000 records landed in one answer, fields inline, filtered and counted',
    writes: 1,
    input: () =>
      runInput(
        movement('  n = count(kg-[c:company WHERE c.`stage` == "Seed" AND c.`revenue` > 5000]->)\n  write kg-[:note]-> { text: "${n}" }'),
        webhook({ subject: 'Acme', text: 'hello' }),
        { companies: LANDED, inline: true },
      ),
  },
  {
    name: 'document',
    why: 'a 256 KB non-ASCII document in the trigger, slugged through the environment services and written',
    writes: 1,
    input: () =>
      runInput(movement('  write kg-[:note]-> { text: Text.slug(msg.`text`) }'), webhook({ subject: 'Acme', text: DOCUMENT }), {
        companies: [],
        inline: false,
      }),
  },
];
