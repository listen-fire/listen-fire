// The embedded host's listens are the check's plans: an arrival a module
// reports runs every saved listen on its edge whose judge fires it, a manual
// run is an Invocation arriving, and a listen this host would not fire as it
// is written is refused at save, by name.

import { BASE_RUNTIME_CAPABILITIES, type Arrival } from 'engine-contracts';
import { defineModule, type ModuleContext } from 'module-kit';
import type { Adapter } from 'movement-engine/public/adapter';
import { listenPipeline } from 'movement-engine/public/inbound';

import { createEmbeddedHost, memoryEmbeddedHostStore } from '..';

/** A CRM: its companies, a listenable root collection, and each company's
 *  people, listenable too, an arrival on them carrying their company when
 *  `carried`; when not, its companies are cheap to list, so a listen may
 *  filter them by listing them. Every company it is asked to create is
 *  written down. */
function crmModule(written: string[], options: { carried: boolean }) {
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
        ...(options.carried ? {} : { cheapToList: true, relistEverySeconds: 3600 }),
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
        fields: [field('Name')],
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
      return data !== null && typeof data === 'object' ? (Reflect.get(data, fieldId) ?? null) : null;
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

async function setup(options: { carried?: boolean } = {}) {
  const written: string[] = [];
  const warned: string[] = [];
  const crm = crmModule(written, { carried: options.carried ?? true });
  const store = memoryEmbeddedHostStore();
  const host = createEmbeddedHost({ modules: [crm], store, log: { warn: (message) => void warned.push(message) }, moduleHost: () => ({ validateResults: true }) });
  await host.connect('acme', { name: 'north', module: crm, credential: { space: 'north' } });
  return { host, store, written, warned };
}

describe("the embedded host's listens", () => {
  it('an embedded host fires a saved program whose listen judges the arrival', async () => {
    const { host, written } = await setup();
    expect(await host.save('acme', { name: 'acme', source: program('listen to app-[c:Companies WHERE c.Name == "Acme"]-> fire f') })).toEqual({ saved: true, listens: 1 });

    const fired = await host.dispatch('acme', { adapterType: 'crm', connection: 'north', arrivals: [company('Acme'), company('Globex')] });

    expect(fired.map(({ program: name, movement, outcome }) => ({ name, movement, ok: outcome.ok }))).toEqual([{ name: 'acme', movement: 'f', ok: true }]);
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

  it("runs nothing for an arrival another connection's, another module's, on another edge, or saying its record went", async () => {
    const { host, written } = await setup();
    await host.save('acme', { name: 'acme', source: program('listen to app-[:Companies]-> fire f') });

    expect(await host.dispatch('acme', { adapterType: 'crm', connection: 'south', arrivals: [company('Acme')] })).toEqual([]);
    expect(await host.dispatch('acme', { adapterType: 'notes', connection: 'north', arrivals: [company('Acme')] })).toEqual([]);
    expect(await host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme', { edge: 'People', key: 'company:acme' })] })).toEqual([]);
    expect(await host.dispatch('acme', { adapterType: 'crm', arrivals: [{ edge: 'Companies', key: 'company:acme', gone: true }] })).toEqual([]);
    expect(await host.dispatch('globex', { adapterType: 'crm', arrivals: [company('Acme')] })).toEqual([]);
    expect(written).toEqual([]);

    // Addressed to the module's install, it reaches every connection's listens.
    expect(await host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme')] })).toHaveLength(1);
    expect(written).toEqual(['acme: Seen Acme']);
  });

  it('an arrival the judge cannot decide runs nothing, and the host says why once per delivery', async () => {
    const { host, written, warned } = await setup();
    const listen = 'listen to app-[c:Companies WHERE c.Name == "Acme"]->-[p:People]-> fire f';
    expect(await host.save('acme', { name: 'people', source: program(listen, 'p.Name', '<app-[:Person]->>').replace('f(company:', 'f(p:') })).toEqual({
      saved: true,
      listens: 1,
    });
    const person = (name: string, parents?: Array<{ fields: Record<string, unknown> } | null>): Arrival => ({
      edge: 'People',
      key: 'company:acme',
      identity: `person-${name}`,
      landing: { recordId: `person-${name}`, recordType: 'Person', fields: { Name: name } },
      ...(parents !== undefined ? { parents } : {}),
    });

    // One that carries no company cannot be judged: two of them, said once.
    expect(await host.dispatch('acme', { adapterType: 'crm', arrivals: [person('Ann'), person('Bob', [null])] })).toEqual([]);
    expect(warned).toEqual(['people:f: an arrival on People cannot be judged (the arrival carries no Companies record, which this listen\'s filter on it reads): it runs nothing']);
    expect(written).toEqual([]);

    // One that carries its company is judged by it.
    const fired = await host.dispatch('acme', { adapterType: 'crm', arrivals: [person('Cy', [{ fields: { Name: 'Acme' } }]), person('Di', [{ fields: { Name: 'Globex' } }])] });
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

    expect(await host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme')] })).toHaveLength(2);
    written.length = 0;
    expect(await host.dispatch('acme', { adapterType: 'crm', arrivals: [company('Acme', { notFor })] })).toHaveLength(1);
    expect(written).toEqual(['acme: Seen Acme']);
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
    expect(settings).toMatchObject({ saved: false, problems: [expect.stringMatching(/^line 10: `listen to app \{ … \}` is retired in 0\.13: .*: this host fires only a listen on a traversal$/)] });
    expect(await store.programs.list('acme')).toEqual([]);
  });
});
