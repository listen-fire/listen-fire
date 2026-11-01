// How the TypeScript host routes an arrival to a listen on a traversal: the
// pipeline it names the listen by, held to the table listen-fire's Rust reads
// as well (packages/engine-contracts/conformance/listen-pipelines.json), and
// which listens an arrival is judged against.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listenPlanSchema, type Arrival, type ListenPlan } from 'engine-contracts';
import { z } from 'zod';

import { parsePinned } from '../../../movement_engine/program_check';
import { arrivalReceiptKey, arrivalTriggerOf, listenFires, listenPipeline, listenSchemaOf, plannedListensOf, type PlannedListen } from '../listen_plans';

// Test data, not a published export: read where the repository keeps it.
const pipelines = z
  .object({
    cases: z.array(z.object({ case: z.string(), file: z.string(), plan: listenPlanSchema, credential: z.string().nullable(), args: z.array(z.tuple([z.string(), z.string()])), pipeline: z.string() })),
  })
  .parse(JSON.parse(readFileSync(join(__dirname, '../../../../../engine-contracts/conformance/listen-pipelines.json'), 'utf8')));

describe('the pipeline a listen on a traversal is named by', () => {
  it.each(pipelines.cases)('$case', ({ file, plan, credential, args, pipeline }) => {
    expect(listenPipeline({ file, plan, ...(credential !== null ? { credentialName: credential } : {}), constructionArgs: Object.fromEntries(args) })).toBe(pipeline);
  });

  it("reads the credential of the listen's connection from the program, its import alias resolved, wherever the import is written", () => {
    const source = `import { notes } from adapters

book = connect notes using n

function copy(note: <book-[:Notes]->>) {
  return note.Title
}

listen to book-[:Notes]-> fire copy

import { north as n } from credentials
`;
    const program = parsePinned({ source });
    const [planned, ...more] = plannedListensOf({ file: 'notes', program, plans: [notesPlan] });
    expect(more).toEqual([]);
    expect(planned).toEqual({ plan: notesPlan, credentialName: 'north', pipeline: listenPipeline({ file: 'notes', plan: notesPlan, credentialName: 'north' }) });
  });

  it("reads the construction's other arguments from the program as listen-fire reads them, as the table's first case writes them", () => {
    const [first] = pipelines.cases;
    const written = first.args.map(([name, raw]) => `${name}: ${raw}`).join(', ');
    const source = `import { acme_crm } from adapters
import { ${first.credential} } from credentials

crm = connect acme_crm using ${first.credential} { ${written} }

function welcome(c: <crm-[:Companies]->>) {
  return c.Name
}

listen to crm-[c:Companies WHERE c.Name == "Acme"]-> fire welcome
`;
    const [planned] = plannedListensOf({ file: first.file, program: parsePinned({ source }), plans: [first.plan] });
    expect(planned.pipeline).toBe(first.pipeline);
  });

  it("names a listen on the host's manual unit by no credential, and refuses a plan on a name that is no connection", () => {
    const program = parsePinned({ source: 'function file(run: <manual-[:Invocations]->>) {\n  return run.Text\n}\n\nlisten to manual-[:Invocations]-> fire file\n' });
    const manual: ListenPlan = { movement: 'file', connection: 'manual', adapter: 'manual', hops: [{ edge: 'Invocations', from: '', to: 'Invocation', judged: 'arrival' }] };
    expect(plannedListensOf({ file: 'leads', program, plans: [manual] })).toEqual([{ plan: manual, pipeline: listenPipeline({ file: 'leads', plan: manual }) }]);
    expect(() => plannedListensOf({ file: 'leads', program, plans: [{ ...manual, connection: 'crm' }] })).toThrow('leads: the listen that fires file is on `crm`, which is no connection the file makes');
  });
});

const notesPlan: ListenPlan = {
  movement: 'copy',
  connection: 'book',
  adapter: 'notes',
  hops: [
    {
      edge: 'Notes',
      from: '',
      to: 'Note',
      alias: 'n',
      checked: { type: 'compare', op: 'eq', left: { type: 'edge_property', propertyTypeId: 'Title', fieldOnly: true }, right: { type: 'static', value: 'keep' } },
      judged: 'arrival',
    },
  ],
};

const listen: PlannedListen = { plan: notesPlan, pipeline: 'listen:notes:copy:00000000', credentialName: 'north' };

function note(title: string, more: Partial<Exclude<Arrival, { gone: true }>> = {}): Arrival {
  return { edge: 'Notes', identity: 'n1', landing: { recordId: 'n1', recordType: 'Note', fields: { Title: title } }, ...more };
}

describe("the schema of a listen's connection", () => {
  const schema = (name: string) => ({ positions: { [name]: { properties: {}, fieldIds: { Name: name } } }, collections: {} }) as never;
  const crm = {
    constructionArgs: [
      { name: 'credentials', kind: 'credential' as const, required: true },
      { name: 'base', kind: 'position' as const, required: false },
    ],
    schemas: { 'north::[["base","CRM"]]': schema('positioned'), north: schema('unpositioned'), south: schema('another') },
  };
  const of = (listen: { credentialName?: string; constructionArgs?: Record<string, string> }) => Object.keys(listenSchemaOf(crm, listen)?.positions ?? {});

  it("is its credential's at the entry position its construction pins, as listen-fire instantiates it", () => {
    expect(of({ credentialName: 'north', constructionArgs: { base: '"CRM"' } })).toEqual(['positioned']);
  });

  it("falls back to its credential's unpositioned schema, and is never another credential's", () => {
    expect(of({ credentialName: 'north', constructionArgs: { base: '"Ops"' } })).toEqual(['unpositioned']);
    expect(of({ credentialName: 'north' })).toEqual(['unpositioned']);
    expect(of({ credentialName: 'east', constructionArgs: { base: '"CRM"' } })).toEqual([]);
    expect(listenSchemaOf(undefined, { credentialName: 'north' })).toBeUndefined();
  });
});

describe('the receipt a listen takes of an arrival', () => {
  it("is its edge, the record it landed on, its identity and its version, as listen-fire's", () => {
    const landing = { recordId: 'n1', recordType: 'Note', fields: { Title: 'keep' } };
    expect(arrivalReceiptKey({ edge: 'Comments', key: 'note:n0', identity: 'n1', version: '3', landing })).toBe('Comments:note:n0:n1:3');
    expect(arrivalReceiptKey({ edge: 'Notes', identity: 'n1', landing })).toBe('Notes::n1:');
  });
});

describe('which listens an arrival is judged against', () => {
  const delivered = { adapterType: 'notes', credentialName: 'north' };

  it('fires a listen on its module and its last edge whose WHERE takes it, and skips one whose WHERE does not', () => {
    expect(listenFires(listen, note('keep'), delivered, 0)).toEqual({ fires: true });
    expect(listenFires(listen, note('drop'), delivered, 0)).toEqual({ skips: 0 });
  });

  it('skips an arrival on an edge of the same name off another record type, and cannot judge one that does not say its record type', () => {
    const other = note('keep', { landing: { recordId: 'n1', recordType: 'Draft', fields: { Title: 'keep' } } });
    expect(listenFires(listen, other, delivered, 0)).toEqual({ skips: 0, reason: "it has record type Draft, not Note, which this listen's Notes lands on" });
    const untyped = note('keep', { landing: { recordId: 'n1', fields: { Title: 'keep' } } });
    expect(listenFires(listen, untyped, delivered, 0)).toEqual({
      undecided: "the arrival notes reported on Notes does not say its record type, so it cannot be told from another record type's Notes (this listen's lands on Note)",
    });
  });

  it('cannot judge a listen whose WHERE reads a field the module could not read, and judges the arrival as usual where none does', () => {
    const unread = note('keep', { landing: { recordId: 'n1', recordType: 'Note', fields: { Title: null }, unknown: ['Title'] } });
    expect(listenFires(listen, unread, delivered, 0)).toEqual({ undecided: "notes could not read Title of the arrival on Notes, which this listen's filter reads" });
    const elsewhere = note('keep', { landing: { recordId: 'n1', recordType: 'Note', fields: { Title: 'keep' }, unknown: ['Body'] } });
    expect(listenFires(listen, elsewhere, delivered, 0)).toEqual({ fires: true });
  });

  it("judges an arrival addressed to the module's install against every connection's listen, and one for another connection against none of this one's", () => {
    expect(listenFires(listen, note('keep'), { adapterType: 'notes' }, 0)).toEqual({ fires: true });
    expect(listenFires(listen, note('keep'), { adapterType: 'notes', credentialName: 'south' }, 0)).toBeNull();
  });

  it("does not judge an arrival from another module, on another edge, saying its record went, or marked not for this listen's pipeline", () => {
    expect(listenFires(listen, note('keep'), { adapterType: 'crm', credentialName: 'north' }, 0)).toBeNull();
    expect(listenFires(listen, note('keep', { edge: 'Comments' }), delivered, 0)).toBeNull();
    expect(listenFires(listen, { edge: 'Notes', key: 'note:n1', gone: true }, delivered, 0)).toBeNull();
    expect(listenFires(listen, note('keep', { notFor: listen.pipeline }), delivered, 0)).toBeNull();
    expect(listenFires(listen, note('keep', { notFor: 'listen:notes:copy:11111111' }), delivered, 0)).toEqual({ fires: true });
  });

  it('hands the run what landed, and the records it carries, as its trigger', () => {
    const arrived = { edge: 'Notes', identity: 'n1', landing: { recordId: 'n1', fields: { Title: 'keep' } }, parents: [{ fields: { Name: 'Book' } }] };
    expect(arrivalTriggerOf({ pipelineInputId: listen.pipeline, adapterType: 'notes', arrival: arrived, now: new Date('2026-10-31T00:00:00.000Z') })).toEqual({
      pipelineInputId: listen.pipeline,
      adapterType: 'notes',
      triggerType: 'arrival',
      arrival: { adapterType: 'notes', edge: 'Notes', landing: { recordId: 'n1', fields: { Title: 'keep' } }, parents: [{ fields: { Name: 'Book' } }] },
      occurredAt: '2026-10-31T00:00:00.000Z',
    });
  });
});
