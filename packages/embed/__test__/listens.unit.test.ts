// The embedded host's listens are the check's plans: an arrival a module
// reports runs every saved listen on its edge whose judge fires it, a manual
// run is an Invocation arriving, an arrival that does not fit the node a
// listen states its landing is runs nothing, and a listen this host would not
// fire as it is written is refused at save, by name, and runs nothing when a
// store holds it all the same. A program the host cannot read runs nothing,
// and the others still run.

import { BASE_RUNTIME_CAPABILITIES, type Arrival } from 'engine-contracts';
import { defineModule, type ModuleContext } from 'module-kit';
import type { Adapter } from 'movement-engine/public/adapter';
import { listenPipeline, listenPlansOf } from 'movement-engine/public/inbound';
import { ENGINE_VERSION, checkAnswerInRust } from 'movement-engine/public/movement-engine';

import { createEmbeddedHost, memoryEmbeddedHostStore, type SavedProgram } from '..';

/** A CRM: its companies, a listenable root collection, and each company's
 *  people, listenable too, an arrival on them carrying their company when
 *  `carried`; when not, its companies are cheap to list, so a listen may
 *  filter them by listing them. Every company it is asked to create is
 *  written down. When `keyed`, it keys a company's `Name` as `name`. */
function crmModule(written: string[], options: { carried: boolean; keyed?: boolean }) {
  const nameId = options.keyed === true ? 'name' : 'Name';
  const create = (ctx: ModuleContext): Adapter => ({
    adapterType: 'crm',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [
      {
        typeId: 'Company',
        displayName: 'Company',
        collectionName: 'Companies',
        readable: true,
        writable: true,
        listenable: true,
        delivery: 'connection',
        ...(options.carried ? {} : { membersChange: { relistEverySeconds: 3600 } }),
      },
      { typeId: 'Person', displayName: 'Person', readable: false, writable: false },
    ],
    describe: async (typeId) => {
      const field = (name: string) => ({ fieldId: name, displayName: name, kind: 'string' as const, writable: true, required: false });
      if (typeId === 'Person') return { typeId, displayName: 'Person', fields: [field('Name')], references: [] };
      if (typeId !== 'Company') return null;
      return {
        typeId,
        displayName: 'Company',
        fields: [{ ...field('Name'), fieldId: nameId }],
        references: [
          {
            fieldId: 'People',
            name: 'People',
            targetTypeId: 'Person',
            cardinality: 'many' as const,
            direction: 'outgoing' as const,
            readable: false,
            listenable: true,
            delivery: 'connection' as const,
            ...(options.carried ? { carries: ['Companies'] } : {}),
          },
        ],
      };
    },
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = position.identity.data;
      return data !== null && typeof data === 'object' ? (Reflect.get(data, position.recordType === 'Company' && fieldId === 'Name' ? nameId : fieldId) ?? null) : null;
    },
    getRelated: async () => [],
    createRecord: async ({ recordType, fields }) => {
      written.push(`${ctx.config.tenant}: ${String(fields.Name)}`);
      return { adapterType: 'crm', externalId: `company-${written.length}`, recordType, data: { ...fields } };
    },
    updateRecord: async ({ externalId, recordType, fields }) => ({ adapterType: 'crm', externalId, recordType, data: { ...fields }, association: 'none' as const }),
    deleteRecord: async () => {
      throw new Error('not used');
    },
  });
  return defineModule({
    kind: 'adapter',
    name: '@test/crm',
    manifest: {
      adapterType: 'crm',
      displayName: 'CRM',
      description: 'A CRM.',
      supportedTriggers: ['webhook'],
      methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord'],
      declaredCredentials: ['crm'],
      introspectedSchema: true,
    },
    credentials: [{ name: 'crm', kind: 'static', fields: [{ name: 'space' }] }],
    create,
  });
}

/** A webhook door: one untyped edge, `Requests`, each body arriving on it
 *  as its fields. A listen states what the body is. */
function hookModule() {
  const create = (): Adapter => ({
    adapterType: 'hook',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [{ typeId: 'Request', displayName: 'Request', collectionName: 'Requests', readable: false, writable: false, listenable: true, delivery: 'connection' }],
    describe: async () => null,
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async () => [],
    createRecord: async () => {
      throw new Error('not used');
    },
    updateRecord: async () => {
      throw new Error('not used');
    },
    deleteRecord: async () => {
      throw new Error('not used');
    },
  });
  return defineModule({
    kind: 'adapter',
    name: '@test/hook',
    manifest: {
      adapterType: 'hook',
      displayName: 'Hook',
      description: 'A webhook door.',
      supportedTriggers: ['webhook'],
      methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated'],
      declaredCredentials: ['hook'],
      introspectedSchema: true,
    },
    credentials: [{ name: 'hook', kind: 'static', fields: [{ name: 'secret' }] }],
    create,
  });
}

/** A program over the tenant's `north` connection, firing `f`, each run
 *  writing a company named after what fired it. */
function program(listens: string, written = '"Seen ${company.Name}"', param = '<app-[:Companies]->>'): string {
  return `import { crm } from adapters
import { north } from credentials

app = connect crm using north

function f(company: ${param}) {
  write app-[:Companies]-> { Name: ${written} }
}

${listens}
`;
}

function company(name: string, more: Partial<Exclude<Arrival, { gone: true }>> = {}): Arrival {
  return { edge: 'Companies', identity: `company-${name}`, landing: { recordId: `company-${name}`, recordType: 'Company', fields: { Name: name } }, ...more };
}

async function setup(options: { carried?: boolean; keyed?: boolean } = {}) {
  const written: string[] = [];
  const warned: string[] = [];
  const crm = crmModule(written, { carried: options.carried ?? true, ...(options.keyed !== undefined ? { keyed: options.keyed } : {}) });
  const store = memoryEmbeddedHostStore();
  const host = createEmbeddedHost({ modules: [crm], store, log: { warn: (message) => void warned.push(message) }, moduleHost: () => ({ validateResults: true }) });
  await host.connect('acme', { name: 'north', module: crm, credential: { space: 'north' } });
  return { host, store, written, warned };
}

describe("the embedded host's listens", () => {
  it('an embedded host fires a saved program whose listen judges the arrival', async () => {
    const { host, written } = await setup();
    expect(await host.save('acme', { name: 'acme', source: program('listen to app-[c:Companies WHERE c.Name == "Acme"]-> fire f') })).toEqual({ saved: true, listens: 1 });

    const fired = (await host.dispatch('acme', { adapterType: 'crm', connection: 'north', arrivals: [company('Acme'), company('Globex')] })).runs;

    expect(fired.map(({ program: name, movement, outcome }) => ({ name, movement, ok: outcome.ok }))).toEqual([{ name: 'acme', movement: 'f', ok: true }]);
    expect(written).toEqual(['acme: Seen Acme']);
  });

  it('judges an arrival its module keys by its own field ids by the names the listen reads', async () => {
    const { host, written } = await setup({ keyed: true });
    await host.save('acme', { name: 'acme', source: program('listen to app-[c:Companies WHERE c.Name == "Acme"]-> fire f') });
    const keyed = (name: string): Arrival => ({ edge: 'Companies', identity: `company-${name}`, landing: { recordId: `company-${name}`, recordType: 'Company', fields: { name } } });

    const fired = (await host.dispatch('acme', { adapterType: 'crm', connection: 'north', arrivals: [keyed('Acme'), keyed('Globex')] })).runs;

    expect(fired.map(({ outcome }) => outcome.ok)).toEqual([true]);
    expect(written).toEqual(['acme: Seen Acme']);
  });

  it('an embedded program still runs on a manual invocation', async () => {
    const { host, written } = await setup();
    const source = program('listen to manual-[:Invocations]-> fire f', 'run.Text', '<manual-[:Invocations]->>').replace('f(company:', 'f(run:');
    expect(await host.save('acme', { name: 'by-hand', source })).toEqual({ saved: true, listens: 1 });

    const [ran, ...more] = await host.run('acme', { program: 'by-hand', text: 'Initech' });

    expect(more).toEqual([]);
    expect(ran).toMatchObject({ tenant: 'acme', program: 'by-hand', movement: 'f', outcome: { ok: true, parked: false } });
    expect(written).toEqual(['acme: Initech']);
    // A program with no listen on the manual unit, or none saved by that name, runs nothing.
    await host.save('acme', { name: 'acme', source: program('listen to app-[:Companies]-> fire f') });
    expect(await host.run('acme', { program: 'acme' })).toEqual([]);
    expect(await host.run('acme', { program: 'unsaved' })).toEqual([]);
  });

  it('runs nothing for an arrival on another edge, or saying its record went', async () => {
    const { host, written } = await setup();
    await host.save('acme', { name: 'acme', source: program('listen to app-[:Companies]-> fire f') });

    expect((await host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme', { edge: 'People', key: 'company:acme' })] })).runs).toEqual([]);
    expect((await host.dispatch('acme', { adapterType: 'crm', arrivals: [{ edge: 'Companies', key: 'company:acme', gone: true }] })).runs).toEqual([]);
    expect(written).toEqual([]);

    // Addressed to the module's install, it reaches every connection's listens.
    expect((await host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme')] })).runs).toHaveLength(1);
    expect(written).toEqual(['acme: Seen Acme']);
  });

  it('refuses a delivery it cannot route, by name: no such module, connection or tenant connection, an arrival that is none, and a keyless one off a record', async () => {
    const { host, written } = await setup();
    await host.save('acme', { name: 'acme', source: program('listen to app-[:Companies]->-[:People]-> fire f', 'p.Name', '<app-[:Person]->>').replace('f(company:', 'f(p:') });

    await expect(host.dispatch('acme', { adapterType: 'crm', connection: 'teem', arrivals: [company('Acme')] })).rejects.toThrow('tenant acme has no "crm" connection named "teem": its delivery runs nothing');
    await expect(host.dispatch('acme', { adapterType: 'notes', connection: 'north', arrivals: [company('Acme')] })).rejects.toThrow('no module for adapter type "notes"');
    await expect(host.dispatch('globex', { adapterType: 'crm', arrivals: [company('Acme')] })).rejects.toThrow('tenant globex has no "crm" connection: its delivery runs nothing');
    const nameless = { ...company('Acme'), identity: '' };
    await expect(host.dispatch('acme', { adapterType: 'crm', arrivals: [nameless] })).rejects.toThrow('arrival 0 of the "crm" delivery is not an arrival (identity:');
    const keyless: Arrival = { edge: 'People', identity: 'person-ann', landing: { recordId: 'person-ann', recordType: 'Person', fields: { Name: 'Ann' } } };
    await expect(host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme'), keyless] })).rejects.toThrow(
      'arrival 1 on People names no key, and People is no root edge of "crm": a wait on the record it landed on would never hear it; name that record (`key`)',
    );
    expect(written).toEqual([]);
  });

  it('answers each arrival a listen could not judge, with the listen, the arrival, why, and the delivery it came in', async () => {
    const { host, store, written } = await setup();
    const listen = 'listen to app-[c:Companies WHERE c.Name == "Acme"]->-[p:People]-> fire f';
    await host.save('acme', { name: 'people', source: program(listen, 'p.Name', '<app-[:Person]->>').replace('f(company:', 'f(p:') });
    const ann: Arrival = { edge: 'People', key: 'company:acme', identity: 'person-ann', landing: { recordId: 'person-ann', recordType: 'Person', fields: { Name: 'Ann' } } };

    const { runs, notJudged } = await host.dispatch('acme', { adapterType: 'crm', arrivals: [ann] });

    expect(runs).toEqual([]);
    expect(written).toEqual([]);
    const [saved] = await store.programs.list('acme');
    expect(notJudged).toEqual([
      {
        program: 'people',
        movement: 'f',
        pipeline: listenPipeline({ file: 'people', plan: saved.listens[0], credentialName: 'north' }),
        arrival: 'People:company:acme:person-ann:',
        edge: 'People',
        adapterType: 'crm',
        identity: 'person-ann',
        recordId: 'person-ann',
        landing: { recordId: 'person-ann', recordType: 'Person', fields: { Name: 'Ann' } },
        reason: "the arrival carries no Companies record, which this listen's filter on it reads",
        deliveryId: expect.any(String),
      },
    ]);
  });

  it('an arrival the judge cannot decide runs nothing, and the host says why once per delivery', async () => {
    const { host, written, warned } = await setup();
    const listen = 'listen to app-[c:Companies WHERE c.Name == "Acme"]->-[p:People]-> fire f';
    expect(await host.save('acme', { name: 'people', source: program(listen, 'p.Name', '<app-[:Person]->>').replace('f(company:', 'f(p:') })).toEqual({
      saved: true,
      listens: 1,
    });
    const person = (name: string, parents?: Array<{ recordType?: string; fields: Record<string, unknown> } | null>): Arrival => ({
      edge: 'People',
      key: 'company:acme',
      identity: `person-${name}`,
      landing: { recordId: `person-${name}`, recordType: 'Person', fields: { Name: name } },
      ...(parents !== undefined ? { parents } : {}),
    });

    // One that carries no company cannot be judged: two of them, said once.
    expect((await host.dispatch('acme', { adapterType: 'crm', arrivals: [person('Ann'), person('Bob', [null])] })).runs).toEqual([]);
    expect(warned).toEqual(['people:f: an arrival on People cannot be judged (the arrival carries no Companies record, which this listen\'s filter on it reads): it runs nothing']);
    expect(written).toEqual([]);

    // One that carries its company is judged by it; one whose carried record is no company is not this listen's.
    const company = (name: string, recordType = 'Company') => ({ recordType, fields: { Name: name } });
    const fired = (await host.dispatch('acme', { adapterType: 'crm', arrivals: [person('Cy', [company('Acme')]), person('Di', [company('Globex')]), person('Ed', [company('Acme', 'Person')])] })).runs;
    expect(fired).toHaveLength(1);
    expect(written).toEqual(['acme: Cy']);
  });

  it('an arrival marked not for a listen runs every other listen on its edge and not that one', async () => {
    const { host, store, written } = await setup();
    const listens = 'listen to app-[c:Companies WHERE c.Name != "Ignored"]-> fire f\nlisten to app-[c:Companies WHERE c.Name != "Other"]-> fire f';
    expect(await host.save('acme', { name: 'twice', source: program(listens) })).toEqual({ saved: true, listens: 2 });
    const [saved] = await store.programs.list('acme');
    const [first] = saved.listens;
    const notFor = listenPipeline({ file: 'twice', plan: first, credentialName: 'north' });

    expect((await host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme')] })).runs).toHaveLength(2);
    written.length = 0;
    expect((await host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme', { notFor, version: '2' })] })).runs).toHaveLength(1);
    expect(written).toEqual(['acme: Seen Acme']);
  });

  it('an arrival that fits the node a listen states its landing is runs it; one that fits no listen runs nothing, said by each', async () => {
    const written: string[] = [];
    const warned: string[] = [];
    const crm = crmModule(written, { carried: true });
    const hook = hookModule();
    const host = createEmbeddedHost({ modules: [crm, hook], store: memoryEmbeddedHostStore(), log: { warn: (message) => void warned.push(message) }, moduleHost: () => ({ validateResults: true }) });
    await host.connect('acme', { name: 'north', module: crm, credential: { space: 'north' } });
    await host.connect('acme', { name: 'door', module: hook, credential: { secret: 's' } });
    const source = `import { crm, hook } from adapters
import { north, door } from credentials

app = connect crm using north
stripe = connect hook using door

node Payment {
  id: <text>
  amount: <number>
}

node Refund {
  id: <text>
  reason: <text>
}

function paid(p: <Payment>) {
  write app-[:Companies]-> { Name: "Paid \${p.id}" }
}

function refunded(r: <Refund>) {
  write app-[:Companies]-> { Name: "Refunded \${r.id}" }
}

listen to stripe-[:Requests]-><Payment> fire paid
listen to stripe-[:Requests]-><Refund> fire refunded
`;
    expect(await host.save('acme', { name: 'hooks', source })).toEqual({ saved: true, listens: 2 });
    const request = (identity: string, fields: Record<string, unknown>): Arrival => ({ edge: 'Requests', identity, landing: { recordType: 'Request', fields } });

    const fired = (await host.dispatch('acme', { adapterType: 'hook', connection: 'door', arrivals: [request('evt_1', { id: 'pay_1', amount: 12 })] })).runs;

    expect(fired.map(({ movement, outcome }) => ({ movement, ok: outcome.ok }))).toEqual([{ movement: 'paid', ok: true }]);
    expect(written).toEqual(['acme: Paid pay_1']);
    // The Refund listen's misfit is not said: a listen on the edge took the arrival.
    expect(warned).toEqual([]);

    expect((await host.dispatch('acme', { adapterType: 'hook', connection: 'door', arrivals: [request('evt_2', { id: 'pay_2', amount: 'twelve' })] })).runs).toEqual([]);
    expect(written).toEqual(['acme: Paid pay_1']);
    expect(warned).toEqual([
      'hooks:paid: the arrival evt_2 on Requests is not a Payment (`amount` is text, not a number): it runs nothing',
      'hooks:refunded: the arrival evt_2 on Requests is not a Refund (`reason` is missing (text)): it runs nothing',
    ]);
  });

  it('runs nothing for a listen it would refuse at save that a store holds all the same, and says why each time its module delivers', async () => {
    const { host, store, written, warned } = await setup({ carried: false });
    // Saved by a host that refuses neither (an authoring tool's own store).
    const storedAsChecked = async (name: string, source: string): Promise<void> => {
      const answer = checkAnswerInRust({ source, catalog: await host.catalog('acme'), languageVersion: ENGINE_VERSION });
      await store.programs.put('acme', { name, source, languageVersion: ENGINE_VERSION, listens: listenPlansOf(answer) });
    };
    await storedAsChecked('people', program('listen to app-[c:Companies WHERE c.Name == "Acme"]->-[p:People]-> fire f', 'p.Name', '<app-[:Person]->>').replace('f(company:', 'f(p:'));
    // The settings form is refused at every check, so only a store written
    // without one holds it.
    await store.programs.put('acme', { name: 'settings', source: program('listen to app fire f'), languageVersion: ENGINE_VERSION, listens: [] });
    const person: Arrival = { edge: 'People', key: 'company:acme', identity: 'person-ann', landing: { recordId: 'person-ann', recordType: 'Person', fields: { Name: 'Ann' } } };

    expect((await host.dispatch('acme', { adapterType: 'crm', arrivals: [person, { ...person, identity: 'person-bob' }] })).runs).toEqual([]);
    expect(written).toEqual([]);
    expect(warned).toEqual([
      'settings:f: `listen to app { … }` is in the retired settings form, which this host fires only as a listen on a traversal: write it as one and save it again; until then it runs nothing',
      "people:f: the listen that fires f filters `Companies` by a WHERE its module's arrivals do not carry the record for: only listen-fire lists those members to judge it, and this host would fire under every one. Filter that hop on the landing's fields instead, or run the listen on listen-fire: it runs nothing",
    ]);
  });

  it('skips a program it cannot read, or a listen whose landing it cannot check, saying how to mend it; every other one still runs', async () => {
    const { host, store, written, warned } = await setup();
    const source = program('listen to app-[:Companies]-> fire f');
    expect(await host.save('acme', { name: 'current', source })).toEqual({ saved: true, listens: 1 });
    const [current] = await store.programs.list('acme');
    // Saved by 0.12: its listeners, and no plans.
    const stale: SavedProgram = JSON.parse(JSON.stringify({ name: 'stale', source, languageVersion: '0.12.0', listeners: [{ instanceName: 'app', adapter: 'crm', config: {}, movementName: 'f' }] }));
    await store.programs.put('acme', stale);
    await store.programs.put('acme', { ...current, name: 'pinned', languageVersion: '0.12.0' });
    // A stated landing its source does not declare.
    await store.programs.put('acme', { ...current, name: 'misnamed', listens: current.listens.map((plan) => ({ ...plan, landing: 'Payment' })) });

    const fired = (await host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme')] })).runs;

    expect(fired.map(({ program: name, outcome }) => ({ name, ok: outcome.ok }))).toEqual([{ name: 'current', ok: true }]);
    expect(written).toEqual(['acme: Seen Acme']);
    expect(warned).toEqual([
      'stale: saved before this release, without the plan of each listen: save it again; until then it runs nothing',
      expect.stringMatching(/^pinned: .*0\.12\.0.*: save it again; until then it runs nothing$/),
      expect.stringMatching(/^misnamed:f: an arrival on Companies cannot be checked against the node its listen states \(.*Payment.*\): it runs nothing$/),
    ]);
  });

  it('refuses a listen whose earlier hop only listen-fire lists, and one in the retired settings form, naming each', async () => {
    const { host, store } = await setup({ carried: false });
    const resolved = await host.save('acme', {
      name: 'people',
      source: program('listen to app-[c:Companies WHERE c.Name == "Acme"]->-[p:People]-> fire f', 'p.Name', '<app-[:Person]->>').replace('f(company:', 'f(p:'),
    });
    expect(resolved).toEqual({
      saved: false,
      problems: [
        "the listen that fires f filters `Companies` by a WHERE its module's arrivals do not carry the record for: only listen-fire lists those members to judge it, and this host would fire under every one. Filter that hop on the landing's fields instead, or run the listen on listen-fire",
      ],
    });
    const settings = await host.save('acme', { name: 'settings', source: program('listen to app fire f') });
    expect(settings).toMatchObject({ saved: false, problems: [expect.stringMatching(/MOV_LISTEN_SETTINGS_RETIRED \(line 10\): `listen to app \{ … \}` is retired in 0\.13: /)] });
    expect(await store.programs.list('acme')).toEqual([]);
  });
});

/** A desk whose subjects are each a Person or a Company, each owned by a
 *  User, whose notes are announced. */
function deskModule() {
  const field = (name: string) => ({ fieldId: name, displayName: name, kind: 'string' as const, writable: false, required: false });
  const owner = { fieldId: 'Owner', name: 'Owner', targetTypeId: 'User', cardinality: 'one' as const, direction: 'outgoing' as const, readable: true, writable: false };
  const notes = { fieldId: 'Notes', name: 'Notes', targetTypeId: 'Note', cardinality: 'many' as const, direction: 'outgoing' as const, readable: false, listenable: true, delivery: 'connection' as const };
  const create = (): Adapter => ({
    adapterType: 'desk',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [
      { typeId: 'Space', displayName: 'Space', collectionName: 'Spaces', readable: true, writable: false },
      ...['Person', 'Company', 'User', 'Note'].map((typeId) => ({ typeId, displayName: typeId, readable: false, writable: false })),
    ],
    describe: async (typeId) => {
      if (typeId === 'Space') return { typeId, displayName: 'Space', fields: [field('Id')], references: [{ fieldId: 'Subjects', name: 'Subjects', targetTypeId: 'Person', targetTypeIds: ['Person', 'Company'], cardinality: 'many' as const, direction: 'outgoing' as const, readable: true, writable: false }] };
      if (typeId === 'Person' || typeId === 'Company') return { typeId, displayName: typeId, fields: [field('Name')], references: [owner] };
      if (typeId === 'User') return { typeId, displayName: 'User', fields: [field('Id')], references: [notes] };
      if (typeId === 'Note') return { typeId, displayName: 'Note', fields: [field('Text')], references: [] };
      return null;
    },
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async () => null,
    getRelated: async () => [],
    createRecord: async () => {
      throw new Error('not used');
    },
    updateRecord: async () => {
      throw new Error('not used');
    },
    deleteRecord: async () => {
      throw new Error('not used');
    },
  });
  return defineModule({
    kind: 'adapter',
    name: '@test/desk',
    manifest: {
      adapterType: 'desk',
      displayName: 'Desk',
      description: 'A desk.',
      supportedTriggers: ['webhook'],
      methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated'],
      declaredCredentials: ['desk'],
      introspectedSchema: true,
    },
    credentials: [{ name: 'desk', kind: 'static', fields: [{ name: 'space' }] }],
    create,
  });
}

describe('a listen through a union on the embedded host', () => {
  it('is one listen: saved as one, run once per arrival, and not judged once', async () => {
    const warned: string[] = [];
    const desk = deskModule();
    const store = memoryEmbeddedHostStore();
    const host = createEmbeddedHost({ modules: [desk], store, log: { warn: (message) => void warned.push(message) }, moduleHost: () => ({ validateResults: true }) });
    await host.connect('acme', { name: 'main', module: desk, credential: { space: 'main' } });
    const source = `import { desk } from adapters
import { main } from credentials

d = connect desk using main

function noted(n: <d-[:Note]->>) {
  return n.Text
}

listen to d-[:Spaces]->-[:Subjects]->-[:Owner]->-[:Notes]-> fire noted
`;
    expect(await host.save('acme', { name: 'notes', source })).toEqual({ saved: true, listens: 1 });
    const [saved] = await store.programs.list('acme');
    expect(saved?.listens).toHaveLength(1);
    expect(saved?.listens[0]?.members?.map((member) => member.hops[1]?.to)).toEqual(['Company', 'Person']);

    const note = (identity: string, recordType?: string): Arrival => ({ edge: 'Notes', key: 'user-1', identity, landing: { recordId: identity, ...(recordType !== undefined ? { recordType } : {}), fields: { Text: identity } } });
    const { runs } = await host.dispatch('acme', { adapterType: 'desk', arrivals: [note('n1', 'Note')] });
    expect(runs.map(({ movement, outcome }) => ({ movement, ok: outcome.ok }))).toEqual([{ movement: 'noted', ok: true }]);

    const { runs: none, notJudged } = await host.dispatch('acme', { adapterType: 'desk', arrivals: [note('n2')] });
    expect(none).toEqual([]);
    expect(notJudged).toEqual([
      expect.objectContaining({
        program: 'notes',
        movement: 'noted',
        pipeline: listenPipeline({ file: 'notes', plan: saved?.listens[0] ?? { movement: '', connection: '', adapter: '', hops: [] }, credentialName: 'main' }),
        reason: "the arrival desk reported on Notes does not say its record type, so it cannot be told from another record type's Notes (this listen's lands on Note)",
      }),
    ]);
  });
});
