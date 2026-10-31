// The embedded host end to end over a module loaded in process: an event runs
// only the listens that hear it (its tenant's, on the connection it came
// for), a run that sleeps is stepped on by the tick past its wake, a run that
// awaits a comment is woken by its arrival, and a tenant's catalog is rebuilt
// when its connection or its schema changes.

import type { Adapter, DiscriminableEvent } from 'movement-engine/public/adapter';
import { BASE_RUNTIME_CAPABILITIES } from 'engine-contracts';
import { defineModule, type AdapterModuleMethods, type ModuleContext } from 'module-kit';

import { createEmbeddedHost, memoryEmbeddedHostStore } from '..';

const NOTE_CREATED = 'note.created';

interface Written {
  tenant: string;
  book: string;
  Title: string;
}

/** A notes service: each tenant's fields on `Note` from `schemas`, every
 *  write recorded with the tenant and the book its credential names, every
 *  update with the record's id. */
function notesModule(written: Written[], schemas: Map<string, string[]>, updated: Array<{ externalId: string; Title: string }> = []) {
  const create = (ctx: ModuleContext): AdapterModuleMethods => {
    const tenant = ctx.config.tenant;
    const adapter: Adapter = {
      adapterType: 'notes',
      supportedTriggers: ['webhook'],
      runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
      listEntryPoints: async () => [
        { typeId: 'Note', displayName: 'Note', readable: true, writable: true },
        { typeId: 'Comment', displayName: 'Comment', readable: false, writable: false },
      ],
      describe: async (typeId) => {
        if (typeId === 'Comment') {
          const fields = ['Id', 'Body'].map((name) => ({ fieldId: name, displayName: name, kind: 'string' as const, writable: false, required: false }));
          return { typeId, displayName: 'Comment', fields, references: [] };
        }
        if (typeId !== 'Note') return null;
        return {
          typeId: 'Note',
          displayName: 'Note',
          fields: ['Title', ...(schemas.get(tenant) ?? [])].map((name) => ({ fieldId: name, displayName: name, kind: 'string' as const, writable: true, required: false })),
          // What people say about a note, announced as it is said.
          references: [{ fieldId: 'Comments', name: 'Comments', targetTypeId: 'Comment', cardinality: 'many' as const, direction: 'outgoing' as const, readable: false, listenable: true, identity: 'Id' }],
        };
      },
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
      updateRecord: async ({ externalId, recordType, fields }) => {
        updated.push({ externalId, Title: String(fields.Title) });
        return { adapterType: 'notes', externalId, recordType, data: { ...fields }, association: 'none' as const };
      },
      deleteRecord: async () => {
        throw new Error('not used');
      },
      listEventTypes: async () => [{ tag: NOTE_CREATED, positionType: 'Note' }],
      arrivals: { awaitKeys: async ({ heads }) => heads.map((head) => ({ key: `note:${head.recordId}` })) },
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
      methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'listEventTypes', 'awaitKeys'],
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
  const updated: Array<{ externalId: string; Title: string }> = [];
  const schemas = new Map<string, string[]>();
  const notes = notesModule(written, schemas, updated);
  const host = createEmbeddedHost({ modules: [notes], ...options, moduleHost: () => ({ validateResults: true }) });
  return { host, notes, written, updated, schemas };
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

  it('a write to the event parameter updates the record the event fired on, through updateRecord', async () => {
    const { host, notes, written, updated } = setup();
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    const source = `import { notes } from adapters
import { north } from credentials

book = connect notes using north

function seen(note: <book-[:Note]->>) {
  write note { Title: "Seen \${note.Title}" }
}

listen to book { events: ["${NOTE_CREATED}"] } fire seen
`;
    expect(await host.save('acme', { name: 'seen', source })).toEqual({ saved: true, listens: 1 });
    const [fired] = await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    expect(fired?.outcome).toMatchObject({ ok: true });
    expect(updated).toEqual([{ externalId: 'n1', Title: 'Seen one' }]);
    expect(written).toEqual([]);
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

  it('parks a run that awaits a comment, and the comment arriving steps it on to its write, binding what arrived', async () => {
    const { host, notes, written } = setup();
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    expect(await host.save('acme', { name: 'reply', source: copier('north', 'Re', 'said = await note-[:Comments]->\n  ').replace('${note.Title}', '${said.Body}') })).toEqual({
      saved: true,
      listens: 1,
    });

    const [fired] = await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    expect(fired.outcome).toEqual({ ok: true, writes: [], spentMicrodollars: 0, parked: true });
    // Nothing arrived on another note, or for another tenant.
    const comment = { edge: 'Comments', identity: 'c1', landing: { recordId: 'c1', recordType: 'Comment', fields: { Id: 'c1', Body: 'lunch?' } } };
    expect(await host.arrive('acme', { adapterType: 'notes', arrivals: [{ ...comment, key: 'note:n2' }] })).toEqual([]);
    expect(await host.arrive('globex', { adapterType: 'notes', arrivals: [{ ...comment, key: 'note:n1' }] })).toEqual([]);
    expect(await host.tick()).toEqual([]);
    expect(written).toEqual([]);

    const [stepped, ...more] = await host.arrive('acme', { adapterType: 'notes', arrivals: [{ ...comment, key: 'note:n1' }] });
    expect(more).toEqual([]);
    expect(stepped).toMatchObject({ runId: fired.runId, program: 'reply', outcome: { ok: true, parked: false } });
    expect(written).toEqual([{ tenant: 'acme', book: 'acme-north', Title: 'Re lunch?' }]);
    // A sender's retry of the same comment wakes nothing.
    expect(await host.arrive('acme', { adapterType: 'notes', arrivals: [{ ...comment, key: 'note:n1' }] })).toEqual([]);
  });

  it("steps only the arriving tenant's woken runs: another tenant's wake stays due for its own step", async () => {
    const store = memoryEmbeddedHostStore();
    const written: Written[] = [];
    const notes = notesModule(written, new Map());
    const host = createEmbeddedHost({ modules: [notes], store, moduleHost: () => ({ validateResults: true }) });
    const reply = copier('north', 'Re', 'said = await note-[:Comments]->\n  ').replace('${note.Title}', '${said.Body}');
    for (const tenant of ['acme', 'globex']) {
      await host.connect(tenant, { name: 'north', module: notes, credential: { book: `${tenant}-north` } });
      await host.save(tenant, { name: 'reply', source: reply });
    }
    const [fired] = await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    const comment = { edge: 'Comments', key: 'note:n1', identity: 'c1', landing: { recordId: 'c1', recordType: 'Comment', fields: { Id: 'c1', Body: 'lunch?' } } };

    // Another process holds acme's run: its wake goes back, due.
    const held = await store.runHost.leases.claim({ runId: fired.runId, ttlMs: 60_000 });
    expect(held).not.toBeNull();
    expect(await host.arrive('acme', { adapterType: 'notes', arrivals: [comment] })).toEqual([]);
    if (held !== null) await store.runHost.leases.release({ runId: fired.runId, token: held.token });

    expect(await host.arrive('globex', { adapterType: 'notes', arrivals: [{ ...comment, identity: 'c2' }] })).toEqual([]);
    expect(written).toEqual([]);
    const [stepped, ...more] = await host.tick();
    expect(more).toEqual([]);
    expect(stepped).toMatchObject({ runId: fired.runId, tenant: 'acme', outcome: { ok: true, parked: false } });
    expect(written).toEqual([{ tenant: 'acme', book: 'acme-north', Title: 'Re lunch?' }]);
  });

  it('settles a race whose arm won before its drain died: the race is owed, and the tick settles it', async () => {
    const store = memoryEmbeddedHostStore();
    const owedRaces = store.runHost.parks.owedRaces;
    let dies = false;
    store.runHost.parks.owedRaces = async (input) => {
      if (!dies) return owedRaces(input);
      dies = false;
      throw new Error('the drain died');
    };
    const written: Written[] = [];
    const notes = notesModule(written, new Map());
    const host = createEmbeddedHost({ modules: [notes], store, moduleHost: () => ({ validateResults: true }) });
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    const raced = `r = race(
    () => {
      said = await note-[:Comments]->
      return said.Body
    },
    () => {
      await sleep(1h)
      return "slept"
    },
  )
  `;
    const source = copier('north', 'Re', raced).replace('${note.Title}', '${coalesce(r[0], "-")}/${coalesce(r[1], "-")}');
    expect(await host.save('acme', { name: 'raced', source })).toEqual({ saved: true, listens: 1 });
    const [fired] = await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    expect(fired.outcome).toMatchObject({ ok: true, parked: true });

    const comment = { edge: 'Comments', key: 'note:n1', identity: 'c1', landing: { recordId: 'c1', recordType: 'Comment', fields: { Id: 'c1', Body: 'lunch?' } } };
    dies = true;
    await expect(host.arrive('acme', { adapterType: 'notes', arrivals: [comment] })).rejects.toThrow('the drain died');
    expect(written).toEqual([]);
    expect((await owedRaces({ runId: fired.runId })).length).toBe(1);

    const [settled, ...more] = await host.tick();
    expect(more).toEqual([]);
    expect(settled).toMatchObject({ runId: fired.runId, outcome: { ok: true, parked: false } });
    expect(written).toEqual([{ tenant: 'acme', book: 'acme-north', Title: 'Re lunch?/-' }]);
    expect(await owedRaces({ runId: fired.runId })).toEqual([]);
    expect(await store.runHost.runStatus({ runId: fired.runId })).toBe('completed');
    // The losing arm's sleep went with the race: its wake steps nothing.
    expect(await host.tick(new Date(Date.now() + 2 * 3_600_000))).toEqual([]);
  });

  it("leaves a run parked when its step's last write finds the lease lost: the wake retries, and the run completes under its next holder", async () => {
    const store = memoryEmbeddedHostStore();
    const { leases, parks } = store.runHost;
    const commitSegment = parks.commitSegment;
    // Another process takes the run over just before the step's end is
    // written: the write, fenced by the lease the step lost, writes nothing.
    let takeOver = false;
    let theirs: string | undefined;
    parks.commitSegment = async (input) => {
      if (takeOver && input.resumed !== null && input.fence !== undefined) {
        takeOver = false;
        await leases.release({ runId: input.runId, token: input.fence });
        theirs = (await leases.claim({ runId: input.runId, ttlMs: 60_000 }))?.token;
      }
      return commitSegment(input);
    };
    const written: Written[] = [];
    const notes = notesModule(written, new Map());
    const host = createEmbeddedHost({ modules: [notes], store, moduleHost: () => ({ validateResults: true }) });
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    await host.save('acme', { name: 'reply', source: copier('north', 'Re', 'said = await note-[:Comments]->\n  ').replace('${note.Title}', '${said.Body}') });
    const [fired] = await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    const comment = { edge: 'Comments', key: 'note:n1', identity: 'c1', landing: { recordId: 'c1', recordType: 'Comment', fields: { Id: 'c1', Body: 'lunch?' } } };

    takeOver = true;
    await host.arrive('acme', { adapterType: 'notes', arrivals: [comment] });
    expect(theirs).toBeDefined();
    expect(await store.runHost.runStatus({ runId: fired.runId })).toBe('parked');
    expect((await parks.leaves({ runId: fired.runId, parkedOnly: true })).length).toBe(1);
    // Its wake went back due: held by the other process, it is busy again.
    expect(await host.tick()).toEqual([]);
    if (theirs !== undefined) await leases.release({ runId: fired.runId, token: theirs });

    // The segment whose end was never written runs again under the next
    // holder, and that end completes the run.
    const [stepped, ...more] = await host.tick();
    expect(more).toEqual([]);
    expect(stepped).toMatchObject({ runId: fired.runId, outcome: { ok: true, parked: false } });
    expect(written).toEqual([
      { tenant: 'acme', book: 'acme-north', Title: 'Re lunch?' },
      { tenant: 'acme', book: 'acme-north', Title: 'Re lunch?' },
    ]);
    expect(await store.runHost.runStatus({ runId: fired.runId })).toBe('completed');
    expect(await parks.leaves({ runId: fired.runId })).toEqual([]);
  });

  it('steps no run that is no longer parked: its row goes, and the run is left as it is', async () => {
    const store = memoryEmbeddedHostStore();
    const written: Written[] = [];
    const notes = notesModule(written, new Map());
    const host = createEmbeddedHost({ modules: [notes], store, moduleHost: () => ({ validateResults: true }) });
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    await host.save('acme', { name: 'reply', source: copier('north', 'Re', 'said = await note-[:Comments]->\n  ').replace('${note.Title}', '${said.Body}') });
    const [fired] = await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    // The run failed meanwhile, before its leaves were torn down.
    await store.runHost.parks.commitSegment({ runId: fired.runId, teamId: 'acme', resumed: null, joins: [], parks: [], settle: { status: 'failed', outcome: null, at: new Date().toISOString() } });

    const comment = { edge: 'Comments', key: 'note:n1', identity: 'c1', landing: { recordId: 'c1', recordType: 'Comment', fields: { Id: 'c1', Body: 'lunch?' } } };
    expect(await host.arrive('acme', { adapterType: 'notes', arrivals: [comment] })).toEqual([]);
    expect(written).toEqual([]);
    expect(await store.runHost.runStatus({ runId: fired.runId })).toBe('failed');
    expect((await store.runHost.parks.leaves({ runId: fired.runId, parkedOnly: true })).length).toBe(1);
    expect(await store.runHost.work.claimDue({ limit: 10, leaseMs: 60_000 })).toEqual([]);
  });

  it("settles a run in its step's end: a process that dies right after that write leaves the run completed, not parked with nothing to wake it", async () => {
    const store = memoryEmbeddedHostStore();
    const { parks } = store.runHost;
    const commitSegment = parks.commitSegment;
    let dies = false;
    parks.commitSegment = async (input) => {
      const wakes = await commitSegment(input);
      if (dies && input.resumed !== null) {
        dies = false;
        throw new Error('the process died');
      }
      return wakes;
    };
    const written: Written[] = [];
    const notes = notesModule(written, new Map());
    const host = createEmbeddedHost({ modules: [notes], store, moduleHost: () => ({ validateResults: true }) });
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    await host.save('acme', { name: 'reply', source: copier('north', 'Re', 'said = await note-[:Comments]->\n  ').replace('${note.Title}', '${said.Body}') });
    const [fired] = await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    expect(await store.runHost.runStatus({ runId: fired.runId })).toBe('parked');

    const comment = { edge: 'Comments', key: 'note:n1', identity: 'c1', landing: { recordId: 'c1', recordType: 'Comment', fields: { Id: 'c1', Body: 'lunch?' } } };
    dies = true;
    await expect(host.arrive('acme', { adapterType: 'notes', arrivals: [comment] })).rejects.toThrow('the process died');
    expect(written).toEqual([{ tenant: 'acme', book: 'acme-north', Title: 'Re lunch?' }]);
    expect(await store.runHost.runStatus({ runId: fired.runId })).toBe('completed');
    expect(await parks.leaves({ runId: fired.runId })).toEqual([]);
  });

  it('steps nothing for a timer row of a run that ended, and never arms it again', async () => {
    let now = new Date('2026-10-27T09:00:00.000Z');
    const store = memoryEmbeddedHostStore({ now: () => now.getTime() });
    const written: Written[] = [];
    const notes = notesModule(written, new Map());
    const host = createEmbeddedHost({ modules: [notes], store, now: () => now, moduleHost: () => ({ validateResults: true }) });
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    await host.save('acme', { name: 'later', source: copier('north', 'Later', 'await sleep(1h)\n  ') });
    const [fired] = await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    // The run failed meanwhile, before its timer leaf was torn down.
    await store.runHost.parks.commitSegment({ runId: fired.runId, teamId: 'acme', resumed: null, joins: [], parks: [], settle: { status: 'failed', outcome: null, at: now.toISOString() } });

    now = new Date('2026-10-27T10:00:01.000Z');
    expect(await host.tick()).toEqual([]);
    expect(written).toEqual([]);
    expect(await store.runHost.runStatus({ runId: fired.runId })).toBe('failed');
    expect((await store.runHost.parks.leaves({ runId: fired.runId, parkedOnly: true })).length).toBe(1);
    expect(await store.runHost.work.claimDue({ limit: 10, leaseMs: 60_000, dueBy: '2026-10-30T00:00:00.000Z' })).toEqual([]);
  });

  it('a row that throws is the error thrown, though a release after it fails; the rows after it go back as never attempted', async () => {
    let now = new Date('2026-10-27T09:00:00.000Z');
    const store = memoryEmbeddedHostStore({ now: () => now.getTime() });
    const released: Array<{ kind: string; why: string | undefined }> = [];
    store.runHost.work.release = async (work) => {
      released.push({ kind: work.kind, why: work.why });
      throw new Error('the store is down');
    };
    const notes = notesModule([], new Map());
    const host = createEmbeddedHost({ modules: [notes], store, now: () => now, moduleHost: () => ({ validateResults: true }) });
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    await host.save('acme', { name: 'later', source: copier('north', 'Later', 'await sleep(1h)\n  ') });
    await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    await store.runHost.work.enqueue({ kind: 'wake_await', key: 'wake_await:malformed', payload: {}, dueAt: '2026-10-27T09:30:00.000Z' });

    now = new Date('2026-10-27T10:00:01.000Z');
    await expect(host.tick()).rejects.toThrow('names no wait');
    expect(released).toEqual([{ kind: 'resume_timer', why: 'busy' }]);
  });

  it('a row that throws stays leased; the rows claimed after it go back due at once', async () => {
    let now = new Date('2026-10-27T09:00:00.000Z');
    const store = memoryEmbeddedHostStore({ now: () => now.getTime() });
    const written: Written[] = [];
    const notes = notesModule(written, new Map());
    const host = createEmbeddedHost({ modules: [notes], store, now: () => now, moduleHost: () => ({ validateResults: true }) });
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    await host.save('acme', { name: 'later', source: copier('north', 'Later', 'await sleep(1h)\n  ') });
    await host.dispatch('acme', { adapterType: 'notes', event: noteCreated('one') });
    // A wake whose payload names no wait, due before the run's timer.
    await store.runHost.work.enqueue({ kind: 'wake_await', key: 'wake_await:malformed', payload: {}, dueAt: '2026-10-27T09:30:00.000Z' });

    now = new Date('2026-10-27T10:00:01.000Z');
    await expect(host.tick()).rejects.toThrow('names no wait');
    expect(written).toEqual([]);
    const due = await store.runHost.work.claimDue({ limit: 10, leaseMs: 60_000 });
    expect(due.map((row) => row.kind)).toEqual(['resume_timer']);
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

  it("runs one program now through the run host's manual unit, its text the Invocation's Text", async () => {
    const { host, notes, written } = setup();
    await host.connect('acme', { name: 'north', module: notes, credential: { book: 'acme-north' } });
    const source = `import { notes } from adapters
import { north } from credentials

book = connect notes using north

function file(run: <manual-[:Invocation]->>) {
  write book-[:Note]-> { Title: "Filed \${run.Text}" }
}

listen to manual fire file
`;
    expect(await host.save('acme', { name: 'file', source })).toEqual({ saved: true, listens: 1 });
    expect(await host.save('acme', { name: 'copy', source: copier('north', 'C') })).toEqual({ saved: true, listens: 1 });

    const [ran, ...more] = await host.run('acme', { program: 'file', text: 'by hand' });
    expect(more).toEqual([]);
    expect(ran).toMatchObject({ tenant: 'acme', program: 'file', movement: 'file', outcome: { ok: true, parked: false } });
    expect(written).toEqual([{ tenant: 'acme', book: 'acme-north', Title: 'Filed by hand' }]);

    // A program with no manual listen, or none saved by that name, runs nothing.
    expect(await host.run('acme', { program: 'copy' })).toEqual([]);
    expect(await host.run('globex', { program: 'file' })).toEqual([]);
  });

  it('refuses a module that is not among its modules', async () => {
    const { host } = setup();
    const other = notesModule([], new Map());
    await expect(host.connect('acme', { name: 'north', module: other, credential: { book: 'b' } })).rejects.toThrow(/not among the host's modules/);
  });
});
