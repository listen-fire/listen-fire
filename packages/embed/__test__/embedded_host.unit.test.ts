// The embedded host end to end over a module loaded in process: an event runs
// only the listens that hear it (its tenant's, on the connection it came
// for), a run that sleeps is stepped on by the tick past its wake, and a
// tenant's catalog is rebuilt when its connection or its schema changes.

import type { Adapter, DiscriminableEvent } from 'movement-engine/public/adapter';
import { BASE_RUNTIME_CAPABILITIES } from 'engine-contracts';
import { defineModule, type AdapterModuleMethods, type ModuleContext } from 'module-kit';

import { createEmbeddedHost } from '..';

const NOTE_CREATED = 'note.created';

interface Written {
  tenant: string;
  book: string;
  Title: string;
}

/** A notes service: each tenant's fields on `Note` from `schemas`, every
 *  write recorded with the tenant and the book its credential names. */
function notesModule(written: Written[], schemas: Map<string, string[]>) {
  const create = (ctx: ModuleContext): AdapterModuleMethods => {
    const tenant = ctx.config.tenant;
    const adapter: Adapter = {
      adapterType: 'notes',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
      listEntryPoints: async () => [{ typeId: 'Note', displayName: 'Note', readable: true, writable: true }],
      describe: async (typeId) =>
        typeId === 'Note'
          ? {
              typeId: 'Note',
              displayName: 'Note',
              fields: ['Title', ...(schemas.get(tenant) ?? [])].map((name) => ({ fieldId: name, displayName: name, kind: 'string' as const, writable: true, required: false })),
              references: [],
            }
          : null,
      resolveEntity: async () => ({ candidates: [] }),
      getFieldValue: async ({ position, fieldId }) => {
        const data = position.identity.kind === 'stable' ? position.identity.data : undefined;
        return data !== null && typeof data === 'object' ? (Reflect.get(data, fieldId) ?? null) : null;
      },
      getRelated: async () => [],
      createRecord: async ({ recordType, fields }) => {
        const book = (await ctx.credential.fields()).book ?? '';
        written.push({ tenant, book, Title: String(fields.Title) });
        return { adapterType: 'notes', externalId: `note-${written.length}`, recordType, data: { ...fields } };
      },
      updateRecord: async () => ({ notFound: true }),
      deleteRecord: async () => {
        throw new Error('not used');
      },
      listEventTypes: async () => [{ tag: NOTE_CREATED, positionType: 'Note' }],
    };
    return adapter;
  };
  return defineModule({
    kind: 'adapter',
    name: '@test/notes',
    manifest: {
      adapterType: 'notes',
      displayName: 'Notes',
      description: 'A notes service.',
      supportedTriggers: ['webhook'],
      methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'listEventTypes'],
      subscribableEvents: [NOTE_CREATED],
      declaredCredentials: ['notes'],
      introspectedSchema: true,
    },
    credentials: [{ name: 'notes', kind: 'static', fields: [{ name: 'book' }] }],
    create,
  });
}

/** A program that copies each new note on `connection`, prefixed. */
function copier(connection: string, prefix: string, body = ''): string {
  return `import { notes } from adapters
import { ${connection} } from credentials

book = connect notes using ${connection}

function copy(note: <book-[:Note]->>) {
  ${body}write book-[:Note]-> { Title: "${prefix} \${note.Title}" }
}

listen to book { events: ["${NOTE_CREATED}"] } fire copy
`;
}

function noteCreated(title: string): DiscriminableEvent {
  return { payload: { id: 'n1', Title: title }, externalId: 'n1', tag: NOTE_CREATED, eventType: NOTE_CREATED, changeType: 'create', recordType: 'Note' };
}

function setup(options: { now?: () => Date } = {}) {
  const written: Written[] = [];
  const schemas = new Map<string, string[]>();
  const notes = notesModule(written, schemas);
  const host = createEmbeddedHost({ modules: [notes], ...options, moduleHost: () => ({ validateResults: true }) });
  return { host, notes, written, schemas };
}

describe('the embedded host', () => {
  it("runs only the listens that hear an event: its tenant's, on the connection it came for", async () => {
    const { host, notes, written } = setup();
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    await host.connect('acme', { name: 'south', module: notes, credential: { book: 'acme-south' } });
    await host.connect('globex', { name: 'north', module: notes, credential: { book: 'globex-north' } });
    expect(await host.save('acme', { name: 'n', source: copier('north', 'N') })).toEqual({ saved: true, listens: 1 });
    expect(await host.save('acme', { name: 's', source: copier('south', 'S') })).toEqual({ saved: true, listens: 1 });
    expect(await host.save('globex', { name: 'n', source: copier('north', 'G') })).toEqual({ saved: true, listens: 1 });

    // For one connection: only its listen, writing through its own credential.
    const north = await host.dispatch('acme', { adapterType: 'notes', connection: 'north', event: noteCreated('one') });
    expect(north.map(({ program, outcome }) => ({ program, ok: outcome.ok }))).toEqual([{ program: 'n', ok: true }]);
    expect(written).toEqual([{ tenant: 'acme', book: 'acme-north', Title: 'N one' }]);

    // For the module's install: every connection's listens, the tenant's only.
    written.length = 0;
    await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('two') });
    expect(written).toEqual([
      { tenant: 'acme', book: 'acme-north', Title: 'N two' },
      { tenant: 'acme', book: 'acme-south', Title: 'S two' },
    ]);

    // An event outside a listen's scope, or from another module, runs nothing.
    expect(await host.dispatch('acme', { adapterType: 'notes', event: { ...noteCreated('x'), eventType: 'note.deleted' } })).toEqual([]);
    expect(await host.dispatch('acme', { adapterType: 'crm', event: noteCreated('x') })).toEqual([]);
  });

  it('parks a run that sleeps, and the tick past its wake steps it on to its write', async () => {
    let now = new Date('2026-10-27T09:00:00.000Z');
    const { host, notes, written } = setup({ now: () => now });
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    await host.save('acme', { name: 'later', source: copier('north', 'Later', 'await sleep(1h)\n  ') });

    const [fired] = await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    expect(fired.outcome).toEqual({ ok: true, writes: [], spentMicrodollars: 0, parked: true });

    now = new Date('2026-10-27T09:30:00.000Z');
    expect(await host.tick()).toEqual([]);
    expect(written).toEqual([]);

    const [stepped, ...more] = await host.tick(new Date('2026-10-27T10:00:01.000Z'));
    expect(more).toEqual([]);
    expect(stepped).toMatchObject({ runId: fired.runId, tenant: 'acme', program: 'later', movement: 'copy', outcome: { ok: true, parked: false } });
    expect(written).toEqual([{ tenant: 'acme', book: 'acme-north', Title: 'Later one' }]);
    expect(await host.tick(new Date('2026-10-28T00:00:00.000Z'))).toEqual([]);
  });

  it("rebuilds a tenant's catalog when it reconnects, or when its schema changes", async () => {
    const { host, notes, schemas } = setup();
    const tagged = (connection: string) => copier(connection, 'T').replace('{ Title:', '{ Tag: "x", Title:');
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    expect(await host.save('acme', { name: 'tagged', source: tagged('north') })).toMatchObject({ saved: false });

    // The schema changed underneath: the cached catalog holds until told.
    schemas.set('acme', ['Tag']);
    expect(await host.save('acme', { name: 'tagged', source: tagged('north') })).toMatchObject({ saved: false });
    host.schemaChanged('acme');
    expect(await host.save('acme', { name: 'tagged', source: tagged('north') })).toEqual({ saved: true, listens: 1 });

    // Reconnecting rebuilds it too: Tag dropped meanwhile, the program no longer checks.
    schemas.delete('acme');
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north-2' } });
    expect(await host.save('acme', { name: 'tagged2', source: tagged('north') })).toMatchObject({ saved: false });

    // A new connection is in the catalog at once; a dropped one is gone.
    expect(await host.save('acme', { name: 'east', source: copier('east', 'E') })).toMatchObject({ saved: false });
    await host.connect('acme', { name: 'east', module: notes, credential: { book: 'acme-east' } });
    expect(await host.save('acme', { name: 'east', source: copier('east', 'E') })).toEqual({ saved: true, listens: 1 });
    await host.disconnect('acme', 'east');
    const refused = await host.save('acme', { name: 'east2', source: copier('east', 'E') });
    expect(refused.saved ? '' : refused.problems.join('\n')).toMatch(/MOV_IMPORT_UNKNOWN/);
  });

  it('refuses a module that is not among its modules', async () => {
    const { host } = setup();
    const other = notesModule([], new Map());
    await expect(host.connect('acme', { name: 'north', module: other, credential: { book: 'b' } })).rejects.toThrow(/not among the host's modules/);
  });
});
