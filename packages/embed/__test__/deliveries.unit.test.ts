// A delivery is one call and one write, as listen-fire keeps it: its
// arrivals are logged and its runs' waits on the records it hands them (the
// trigger, and each record the trigger's arrival carries) opened from the
// mark before them, so a later item of the same delivery answers a run's
// `await new` and the trigger never answers its own; its listens run each
// arrival once, however often it is delivered. Each run it starts is a
// row kept with it: one that does not start inside the call is started by a
// later tick.

import { BASE_RUNTIME_CAPABILITIES, type Arrival } from 'engine-contracts';
import { defineModule } from 'module-kit';
import type { Adapter } from 'movement-engine/public/adapter';
import { RUN_LEASE_TTL_MS } from 'movement-engine/public/run-host';

import { createEmbeddedHost, memoryEmbeddedHostStore, type EmbeddedHostStore } from '..';

/** A chat: its messages, a listenable root, and each message's replies,
 *  listenable too, a reply a message of the same thread. A thread is waited
 *  on under its root's id, as Slack keys one. Every message it is asked to
 *  post is written down. */
function chatModule(posted: string[]) {
  const create = (): Adapter => ({
    adapterType: 'chat',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [
      { typeId: 'Message', displayName: 'Message', collectionName: 'Messages', readable: true, writable: true, listenable: true, delivery: 'connection' },
    ],
    describe: async (typeId) => {
      if (typeId !== 'Message') return null;
      const field = (name: string) => ({ fieldId: name, displayName: name, kind: 'string' as const, writable: true, required: false });
      return {
        typeId,
        displayName: 'Message',
        fields: ['Id', 'Thread', 'Text'].map(field),
        references: [
          {
            fieldId: 'Replies',
            name: 'Replies',
            targetTypeId: 'Message',
            cardinality: 'many' as const,
            direction: 'outgoing' as const,
            readable: false,
            listenable: true,
            delivery: 'connection' as const,
            identity: 'Id',
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
      posted.push(String(fields.Text));
      return { adapterType: 'chat', externalId: `posted-${posted.length}`, recordType, data: { ...fields } };
    },
    updateRecord: async () => {
      throw new Error('not used');
    },
    deleteRecord: async () => {
      throw new Error('not used');
    },
    arrivals: {
      awaitKeys: async ({ heads }) => heads.map((head) => ({ key: `thread:${String(head.headData?.Thread ?? head.recordId)}` })),
    },
  });
  return defineModule({
    kind: 'adapter',
    name: '@test/chat',
    manifest: {
      adapterType: 'chat',
      displayName: 'Chat',
      description: 'A chat.',
      supportedTriggers: ['webhook'],
      methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'awaitKeys'],
      declaredCredentials: ['chat'],
      introspectedSchema: true,
    },
    credentials: [{ name: 'chat', kind: 'static', fields: [{ name: 'workspace' }] }],
    create,
  });
}

/** A program over the tenant's `team` connection: `answer` fires on `listen`,
 *  its parameter `<param>`, and posts the next reply off what fired it. */
function answering(listen: string, param: string): string {
  return `import { chat } from adapters
import { team } from credentials

room = connect chat using team

function answer(m: <${param}>) {
  next = await new m-[:Replies]->
  write room-[:Messages]-> { Text: "Re \${next.Text}" }
}

listen to ${listen} fire answer
`;
}

function message(id: string, text: string): Arrival {
  return { edge: 'Messages', identity: id, landing: { recordId: id, recordType: 'Message', fields: { Id: id, Thread: id, Text: text } } };
}

function reply(id: string, thread: string, text: string): Arrival {
  return { edge: 'Replies', key: `thread:${thread}`, identity: id, landing: { recordId: id, recordType: 'Message', fields: { Id: id, Thread: thread, Text: text } } };
}

async function setup() {
  const posted: string[] = [];
  const warned: string[] = [];
  const chat = chatModule(posted);
  const store = memoryEmbeddedHostStore();
  const host = createEmbeddedHost({ modules: [chat], store, log: { warn: (line) => void warned.push(line) }, moduleHost: () => ({ validateResults: true }) });
  await host.connect('acme', { name: 'team', module: chat, credential: { workspace: 'acme' } });
  return { host, store, chat, posted, warned };
}

/** A help desk: its tickets, and each ticket's comments, listenable, each
 *  arriving with its ticket. A comment leads back to its ticket. A ticket's
 *  comments are waited on under its id. Every ticket it is asked to open is
 *  written down by title. */
function deskModule(opened: string[]) {
  const field = (name: string) => ({ fieldId: name, displayName: name, kind: 'string' as const, writable: true, required: false });
  const create = (): Adapter => ({
    adapterType: 'desk',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    // A comment is described, never a root: it is reached off its ticket.
    listEntryPoints: async () => [
      { typeId: 'Ticket', displayName: 'Ticket', collectionName: 'Tickets', readable: true, writable: true },
      { typeId: 'Comment', displayName: 'Comment', readable: false, writable: false },
    ],
    describe: async (typeId) => {
      if (typeId === 'Ticket') {
        return {
          typeId,
          displayName: 'Ticket',
          fields: ['Id', 'Title'].map(field),
          references: [
            {
              fieldId: 'Comments',
              name: 'Comments',
              targetTypeId: 'Comment',
              cardinality: 'many' as const,
              direction: 'outgoing' as const,
              readable: false,
              listenable: true,
              delivery: 'connection' as const,
              identity: 'Id',
              carries: ['Tickets'],
            },
          ],
        };
      }
      if (typeId === 'Comment') {
        return {
          typeId,
          displayName: 'Comment',
          fields: ['Id', 'Ticket', 'Kind', 'Text'].map(field),
          references: [{ fieldId: 'Ticket', name: 'Ticket', targetTypeId: 'Ticket', cardinality: 'one' as const, direction: 'outgoing' as const }],
        };
      }
      return null;
    },
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = position.identity.data;
      return data !== null && typeof data === 'object' ? (Reflect.get(data, fieldId) ?? null) : null;
    },
    getRelated: async ({ position, fieldId }) => {
      const data = position.identity.data;
      const ticket = fieldId === 'Ticket' && data !== null && typeof data === 'object' ? Reflect.get(data, 'Ticket') : undefined;
      if (typeof ticket !== 'string') return [];
      return [{ position: { adapterType: 'desk', recordType: 'Ticket', identity: { kind: 'stable' as const, recordId: ticket, data: { Id: ticket, Title: 'Printer' } } } }];
    },
    createRecord: async ({ recordType, fields }) => {
      opened.push(String(fields.Title));
      return { adapterType: 'desk', externalId: `opened-${opened.length}`, recordType, data: { ...fields } };
    },
    updateRecord: async () => {
      throw new Error('not used');
    },
    deleteRecord: async () => {
      throw new Error('not used');
    },
    arrivals: {
      awaitKeys: async ({ heads }) => heads.map((head) => ({ key: `ticket:${head.recordId}` })),
    },
  });
  return defineModule({
    kind: 'adapter',
    name: '@test/desk',
    manifest: {
      adapterType: 'desk',
      displayName: 'Desk',
      description: 'A help desk.',
      supportedTriggers: ['webhook'],
      methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'awaitKeys'],
      declaredCredentials: ['desk'],
      introspectedSchema: true,
    },
    credentials: [{ name: 'desk', kind: 'static', fields: [{ name: 'workspace' }] }],
    create,
  });
}

/** A question on a ticket waits for the ticket's next comment, and opens a
 *  ticket noting both. */
const FOLLOW = `import { desk } from adapters
import { support } from credentials

help = connect desk using support

function follow(c: <help-[:Comment]->>) {
  c-[t:Ticket]-> {
    next = await new t-[:Comments]->
    write help-[:Tickets]-> { Title: "after \${c.Text}, \${next.Text}" }
  }
}

listen to help-[:Tickets]->-[c:Comments WHERE c.Kind == "question"]-> fire follow
`;

function comment(id: string, kind: string, text: string): Arrival {
  return {
    edge: 'Comments',
    key: 'ticket:t1',
    identity: id,
    landing: { recordId: id, recordType: 'Comment', fields: { Id: id, Ticket: 't1', Kind: kind, Text: text } },
    parents: [{ recordId: 't1', recordType: 'Ticket', fields: { Id: 't1', Title: 'Printer' } }],
  };
}

async function deskSetup() {
  const opened: string[] = [];
  const desk = deskModule(opened);
  const host = createEmbeddedHost({ modules: [desk], store: memoryEmbeddedHostStore(), moduleHost: () => ({ validateResults: true }) });
  await host.connect('acme', { name: 'support', module: desk, credential: { workspace: 'acme' } });
  expect(await host.save('acme', { name: 'follow', source: FOLLOW })).toEqual({ saved: true, listens: 1 });
  return { host, opened };
}

describe('a record the trigger’s arrival carries', () => {
  it('is reached at delivery: a later item of the same delivery on it answers the run’s wait', async () => {
    const { host, opened } = await deskSetup();

    const [ran, ...more] = await host.dispatch('acme', { adapterType: 'desk', arrivals: [comment('c1', 'question', 'jammed?'), comment('c2', 'answer', 'cleared')] });

    expect(more).toEqual([]);
    expect(ran.outcome).toMatchObject({ ok: true, parked: false });
    expect(opened).toEqual(['after jammed?, cleared']);
  });

  it('is never answered by the arrival that started the run; its next item, delivered later, answers it', async () => {
    const { host, opened } = await deskSetup();

    const [first] = await host.dispatch('acme', { adapterType: 'desk', arrivals: [comment('c1', 'question', 'jammed?')] });
    expect(first.outcome).toMatchObject({ ok: true, parked: true });
    expect(opened).toEqual([]);

    const [woken, ...more] = await host.dispatch('acme', { adapterType: 'desk', arrivals: [comment('c2', 'answer', 'cleared')] });
    expect(more).toEqual([]);
    expect(woken.runId).toBe(first.runId);
    expect(woken.outcome).toMatchObject({ ok: true, parked: false });
    expect(opened).toEqual(['after jammed?, cleared']);
  });
});

describe('a delivery', () => {
  it("is kept in one write: a later item of the same delivery answers the run an earlier one started", async () => {
    const { host, posted } = await setup();
    expect(await host.save('acme', { name: 'threads', source: answering('room-[:Messages]->', 'room-[:Messages]->') })).toEqual({ saved: true, listens: 1 });

    const [ran, ...more] = await host.dispatch('acme', { adapterType: 'chat', arrivals: [message('m1', 'lunch?'), reply('r1', 'm1', 'yes')] });

    expect(more).toEqual([]);
    expect(ran.outcome).toMatchObject({ ok: true, parked: false });
    expect(posted).toEqual(['Re yes']);
  });

  it('never answers a run with the arrival that started it; the next one on its thread, delivered later, does', async () => {
    const { host, posted } = await setup();
    expect(await host.save('acme', { name: 'threads', source: answering('room-[:Messages]->-[:Replies]->', 'room-[:Message]->') })).toEqual({
      saved: true,
      listens: 1,
    });

    // The reply waits on its own thread, the edge and key it arrived on.
    const [first] = await host.dispatch('acme', { adapterType: 'chat', arrivals: [reply('r1', 'm1', 'yes')] });
    expect(first.outcome).toMatchObject({ ok: true, parked: true });
    expect(posted).toEqual([]);

    // The next reply starts a run of its own, and wakes the first.
    const ran = await host.dispatch('acme', { adapterType: 'chat', arrivals: [reply('r2', 'm1', 'at noon')] });
    expect(ran.map(({ runId, outcome }) => ({ first: runId === first.runId, parked: outcome.ok && outcome.parked }))).toEqual([
      { first: false, parked: true },
      { first: true, parked: false },
    ]);
    expect(posted).toEqual(['Re at noon']);
  });

  it('runs each listen once for an arrival delivered twice, and nothing for a delivery kept before under its id', async () => {
    const { host, chat, posted, warned } = await setup();
    const source = answering('room-[:Messages]->', 'room-[:Messages]->').replace('next = await new m-[:Replies]->\n  ', '').replace('next.Text', 'm.Text');
    expect(await host.save('acme', { name: 'echo', source })).toEqual({ saved: true, listens: 1 });
    expect(await host.save('acme', { name: 'echo-too', source })).toEqual({ saved: true, listens: 1 });
    await host.connect('globex', { name: 'team', module: chat, credential: { workspace: 'globex' } });
    expect(await host.save('globex', { name: 'echo', source })).toEqual({ saved: true, listens: 1 });

    expect(await host.dispatch('acme', { adapterType: 'chat', arrivals: [message('m1', 'hi')] })).toHaveLength(2);
    // The provider sends it again: each listen has run it.
    expect(await host.dispatch('acme', { adapterType: 'chat', arrivals: [message('m1', 'hi'), message('m2', 'ho')] })).toHaveLength(2);
    expect(posted).toEqual(['Re hi', 'Re hi', 'Re ho', 'Re ho']);
    expect(warned).toEqual([
      'echo:answer has run the arrival m1 on Messages before: this delivery runs nothing',
      'echo-too:answer has run the arrival m1 on Messages before: this delivery runs nothing',
    ]);
    // Another tenant's listen of the same name takes its own receipt.
    expect(await host.dispatch('globex', { adapterType: 'chat', arrivals: [message('m1', 'hi')] })).toHaveLength(1);

    // A delivery under an id already kept runs nothing, and says so.
    posted.length = 0;
    warned.length = 0;
    expect(await host.dispatch('acme', { adapterType: 'chat', id: 'evt-1', arrivals: [message('m3', 'hey')] })).toHaveLength(2);
    expect(await host.dispatch('acme', { adapterType: 'chat', id: 'evt-1', arrivals: [message('m4', 'hey')] })).toEqual([]);
    expect(posted).toEqual(['Re hey', 'Re hey']);
    expect(warned).toEqual(['delivery evt-1 was kept before: it runs nothing']);
  });

  describe('whose run does not start inside the call', () => {
    /** The echo program over a store whose next write of `fault` fails, on a
     *  clock the test moves. */
    async function faulty() {
      const posted: string[] = [];
      const warned: string[] = [];
      const chat = chatModule(posted);
      let clock = Date.parse('2026-10-31T09:00:00.000Z');
      const inner = memoryEmbeddedHostStore({ now: () => clock });
      const faults = { receipt: 0, record: 0 };
      const store: EmbeddedHostStore = {
        ...inner,
        runs: {
          ...inner.runs,
          put: async (run) => {
            if (faults.record > 0 && faults.record-- > 0) throw new Error('the store went away');
            await inner.runs.put(run);
          },
        },
        runHost: {
          ...inner.runHost,
          startArrivalRun: async (start) => {
            if (faults.receipt > 0 && faults.receipt-- > 0) throw new Error('the store went away');
            return inner.runHost.startArrivalRun(start);
          },
        },
      };
      const host = createEmbeddedHost({ modules: [chat], store, now: () => new Date(clock), log: { warn: (line) => void warned.push(line) } });
      await host.connect('acme', { name: 'team', module: chat, credential: { workspace: 'acme' } });
      const source = answering('room-[:Messages]->', 'room-[:Messages]->').replace('next = await new m-[:Replies]->\n  ', '').replace('next.Text', 'm.Text');
      expect(await host.save('acme', { name: 'echo', source })).toEqual({ saved: true, listens: 1 });
      const later = (ms: number): Date => {
        clock += ms;
        return new Date(clock);
      };
      return { host, posted, warned, faults, later };
    }

    it('is started by a tick once a run lease has passed, and a retry under its id runs nothing twice', async () => {
      const { host, posted, warned, faults, later } = await faulty();
      faults.receipt = 1;

      await expect(host.dispatch('acme', { adapterType: 'chat', id: 'evt-1', arrivals: [message('m1', 'hi')] })).rejects.toThrow(
        /1 run\(s\) of the delivery did not start: echo, the arrival m1 on Messages: the store went away: `tick` starts each once a run lease has passed/,
      );
      expect(posted).toEqual([]);
      // Its row is the dispatch's for a run lease.
      expect(await host.tick(later(1000))).toEqual([]);

      // The sender sends it again under its id: kept, and run.
      const [retried, ...none] = await host.dispatch('acme', { adapterType: 'chat', id: 'evt-1', arrivals: [message('m1', 'hi')] });
      expect(none).toEqual([]);
      expect(retried.outcome).toMatchObject({ ok: true });
      expect(posted).toEqual(['Re hi']);

      // The first row starts nothing: its listen has run the arrival.
      expect(await host.tick(later(RUN_LEASE_TTL_MS))).toEqual([]);
      expect(posted).toEqual(['Re hi']);
      expect(warned).toEqual(['echo:answer has run the arrival m1 on Messages before: this delivery runs nothing']);
    });

    it('a tick starts with no retry of the delivery', async () => {
      const { host, posted, faults, later } = await faulty();
      faults.receipt = 1;
      await expect(host.dispatch('acme', { adapterType: 'chat', arrivals: [message('m1', 'hi')] })).rejects.toThrow(/did not start/);

      const [started, ...none] = await host.tick(later(RUN_LEASE_TTL_MS + 1));
      expect(none).toEqual([]);
      expect(started).toMatchObject({ program: 'echo', movement: 'answer', outcome: { ok: true } });
      expect(posted).toEqual(['Re hi']);
      expect(await host.tick(later(RUN_LEASE_TTL_MS + 1))).toEqual([]);
    });

    it('is never stranded by a crash between its receipt and its record: the row starts the run its receipt names', async () => {
      const { host, posted, warned, faults, later } = await faulty();
      faults.record = 1;
      await expect(host.dispatch('acme', { adapterType: 'chat', id: 'evt-1', arrivals: [message('m1', 'hi')] })).rejects.toThrow(/did not start/);
      expect(posted).toEqual([]);

      // A retry of the delivery is kept, and its run refused: the arrival's
      // receipt is the first row's run's.
      expect(await host.dispatch('acme', { adapterType: 'chat', id: 'evt-1', arrivals: [message('m1', 'hi')] })).toEqual([]);
      expect(warned).toEqual(['echo:answer has run the arrival m1 on Messages before: this delivery runs nothing']);

      const [started, ...none] = await host.tick(later(RUN_LEASE_TTL_MS + 1));
      expect(none).toEqual([]);
      expect(started.outcome).toMatchObject({ ok: true });
      expect(posted).toEqual(['Re hi']);
      expect(await host.tick(later(RUN_LEASE_TTL_MS + 1))).toEqual([]);
      expect(posted).toEqual(['Re hi']);
    });
  });
});
