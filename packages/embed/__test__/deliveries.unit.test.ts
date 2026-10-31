// A delivery is one call and one write, as listen-fire keeps it: its
// arrivals are logged and its runs' trigger waits opened from the mark
// before them, so a later item of the same delivery answers a run's
// `await new` and the trigger never answers its own; its listens run each
// arrival once, however often it is delivered.

import { BASE_RUNTIME_CAPABILITIES, type Arrival } from 'engine-contracts';
import { defineModule } from 'module-kit';
import type { Adapter } from 'movement-engine/public/adapter';

import { createEmbeddedHost, memoryEmbeddedHostStore } from '..';

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
});
