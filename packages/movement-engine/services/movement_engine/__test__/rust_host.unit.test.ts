// The shim's park routes for host families version 2: a run's waits on
// listenable edges (`park.waits`), an await parked on its wait, and the wake
// that names the wait. Against a scripted engine double: no WASM.

import { HOST_FAMILIES_VERSION, type LoggedArrival } from 'engine-contracts';
import { makeStablePosition, positionRecordId } from 'engine-contracts/catalog';
import { LANGUAGE_VERSION, mockCatalogSnapshot, type InstanceSchema } from 'movement-lang';

import type { Adapter } from '../../translation_graph/adapter';
import { runMovement } from '../../../public/movement-engine';

import type { EngineHost } from '../host';
import { driveEngine } from '../rust_engine';
import { WireOut } from '../rust_wire';
import type { QueuedWake } from '../host_kit';
import { makeFakeParkSink, makeTestHost } from '../test_host';
import { TEAM, hostWith, inSegment, request, scriptedEngine } from './scripted_engine';

type Waits = NonNullable<EngineHost['park']['waits']>;

type Logged = { arrivals: LoggedArrival[] };

/** A host's waits that record each request and answer from `arrivals`, or
 *  from what it says at each reading. */
function recordingWaits(arrivals: Logged | (() => Logged)): { waits: Waits; asked: Array<[string, unknown]> } {
  const asked: Array<[string, unknown]> = [];
  return {
    asked,
    waits: {
      mark: async (input) => (asked.push(['mark', input]), { mark: 41 }),
      open: async (input) => {
        asked.push(['open', input]);
        const key = 'key' in input ? input.key : 'gone';
        return { waitId: key === 'thread:c1' ? 'wait-1' : `wait:${key}` };
      },
      arrivals: async (input) => (asked.push(['arrivals', input]), typeof arrivals === 'function' ? arrivals() : arrivals),
      note: async (input) => (asked.push(['note', input]), { counts: input.matched }),
    },
  };
}

/** A waits request as the order assertions read it: the method, and the key
 *  or wait it names. */
function label([method, input]: [string, unknown]): string {
  if (typeof input !== 'object' || input === null) return method;
  const subject = 'key' in input ? input.key : 'waitId' in input ? input.waitId : undefined;
  return typeof subject === 'string' ? `${method} ${subject}` : method;
}

/** The longest start of `wanted` that appears in `labels` in its order,
 *  other requests between (as the Rust embed's end-to-end tests read an
 *  order): all of `wanted` when they came in that order. */
function inOrder(labels: string[], wanted: string[]): string[] {
  const found: string[] = [];
  let from = 0;
  for (const want of wanted) {
    const at = labels.indexOf(want, from);
    if (at < 0) break;
    found.push(want);
    from = at + 1;
  }
  return found;
}

describe("the shim's park.waits routes", () => {
  it('forwards park.waits.open with {segmentId, adapterType, edge, key, since} and answers {waitId}', async () => {
    const { waits, asked } = recordingWaits({ arrivals: [] });
    const served = await hostWith({ park: { waits } });
    const segmentId = served.context.segmentId;
    const { engine, answers } = scriptedEngine((seen) =>
      seen.length === 0
        ? { pending: [request(1, 'park.waits', 'open', inSegment(segmentId, { adapterType: 'acme', edge: 'Comments', key: 'thread:c1', since: 41 }))] }
        : { done: { ok: true } },
    );
    await driveEngine(engine, {}, served);
    expect(asked).toEqual([['open', { segmentId, adapterType: 'acme', edge: 'Comments', key: 'thread:c1', since: 41 }]]);
    expect(answers).toEqual([{ id: 1, answer: { value: { waitId: 'wait-1' } } }]);
  });

  it('forwards park.waits.open of a record already gone as {gone: true}, with no key', async () => {
    const { waits, asked } = recordingWaits({ arrivals: [] });
    const served = await hostWith({ park: { waits } });
    const segmentId = served.context.segmentId;
    const { engine, answers } = scriptedEngine((seen) =>
      seen.length === 0
        ? { pending: [request(1, 'park.waits', 'open', inSegment(segmentId, { adapterType: 'acme', edge: 'Comments', gone: true, since: 41 }))] }
        : { done: { ok: true } },
    );
    await driveEngine(engine, {}, served);
    expect(asked).toEqual([['open', { segmentId, adapterType: 'acme', edge: 'Comments', gone: true, since: 41 }]]);
    expect(answers).toEqual([{ id: 1, answer: { value: { waitId: 'wait:gone' } } }]);
  });

  it("answers the mark, the wait's arrivals on the eval wire, and whether a noted arrival counts", async () => {
    const landed: LoggedArrival = { seq: 42, identity: 'k1', version: null, landing: { recordId: 'k1', recordType: 'Comment', fields: { Text: 'hi' } } };
    const { waits, asked } = recordingWaits({ arrivals: [landed] });
    const served = await hostWith({ park: { waits } });
    const segmentId = served.context.segmentId;
    const { engine, answers } = scriptedEngine((seen) =>
      seen.length === 0
        ? {
            pending: [
              request(1, 'park.waits', 'mark', inSegment(segmentId, {})),
              request(2, 'park.waits', 'arrivals', inSegment(segmentId, { waitId: 'wait-1', wire: true })),
              request(3, 'park.waits', 'note', inSegment(segmentId, { waitId: 'wait-1', identity: 'k1', matched: true })),
            ],
          }
        : seen.length < 3
          ? { pending: [] }
          : { done: { ok: true } },
    );
    await driveEngine(engine, {}, served);
    expect(asked).toEqual([
      ['mark', { segmentId }],
      ['arrivals', { segmentId, waitId: 'wait-1' }],
      ['note', { segmentId, waitId: 'wait-1', identity: 'k1', matched: true }],
    ]);
    expect([...answers].sort((a, b) => a.id - b.id)).toEqual([
      { id: 1, answer: { value: { mark: 41 } } },
      { id: 2, answer: { value: new WireOut().value({ arrivals: [landed] }) } },
      { id: 3, answer: { value: { counts: true } } },
    ]);
  });

  it('reads `since` as any integer, as the Rust host does, and refuses one that is not', async () => {
    const opened = async (since: unknown) => {
      const { waits, asked } = recordingWaits({ arrivals: [] });
      const served = await hostWith({ park: { waits } });
      const segmentId = served.context.segmentId;
      const { engine } = scriptedEngine((seen) =>
        seen.length === 0
          ? { pending: [request(1, 'park.waits', 'open', inSegment(segmentId, { adapterType: 'acme', edge: 'Comments', key: 'thread:c1', since }))] }
          : { done: { ok: true } },
      );
      await driveEngine(engine, {}, served);
      return asked;
    };
    expect(await opened(-1)).toEqual([['open', expect.objectContaining({ since: -1 })]]);
    await expect(opened(1.5)).rejects.toThrow('park.waits.open since is an integer');
    await expect(opened('41')).rejects.toThrow('park.waits.open since is an integer');
  });

  it('refuses a waits request of a host that serves no waits, naming the method', async () => {
    const served = await hostWith({});
    const segmentId = served.context.segmentId;
    const { engine } = scriptedEngine(() => ({ pending: [request(1, 'park.waits', 'mark', inSegment(segmentId, {}))] }));
    await expect(driveEngine(engine, {}, served)).rejects.toThrow('park.waits.mark');
  });

  it('commits an await park on its wait, and wakes the run by the wait', async () => {
    const park = makeFakeParkSink();
    const wakes: QueuedWake[] = [];
    const served = await hostWith({ park: { sink: park.sink }, wakes });
    const segmentId = served.context.segmentId;
    const state = { version: 3, address: 's0', bindingName: 'reply', scopeChain: [] };
    const { engine } = scriptedEngine((seen) =>
      seen.length === 0
        ? { pending: [request(1, 'park.sink', 'commitAwaitPark', inSegment(segmentId, { address: 's0', state: new WireOut().value(state), waitId: 'wait-1', wire: true }))] }
        : seen.length === 1
          ? { pending: [request(2, 'park', 'wake', inSegment(segmentId, { waitId: 'wait-1' }))] }
          : { done: { ok: true } },
    );
    await driveEngine(engine, {}, served);
    expect(park.awaitParks).toEqual([{ address: 's0', state, waitId: 'wait-1' }]);
    expect(wakes).toEqual([{ teamId: TEAM, waitId: 'wait-1' }]);
  });
});

describe('a segment opened on the in-process host', () => {
  it('is refused when it carries host families version 1', async () => {
    const host = makeTestHost();
    await expect(host.segment.open({ teamId: TEAM, languageVersion: LANGUAGE_VERSION, hostFamiliesVersion: 1 })).rejects.toThrow(
      'segment.open carries host families version 1, which this host does not serve (supported: 2)',
    );
    await expect(host.segment.open({ teamId: TEAM, languageVersion: LANGUAGE_VERSION, hostFamiliesVersion: HOST_FAMILIES_VERSION })).resolves.toEqual({
      segmentId: expect.any(String),
    });
  });
});

describe('an await on a listenable edge, run in the Rust engine through the shim', () => {
  const chat: InstanceSchema = {
    positions: {
      Message: {
        properties: { Text: 'text', Timestamp: 'text' },
        edges: { Replies: { target: 'Message', listenable: true, sequenced: 'chronological', identity: 'Timestamp' } },
      },
    },
    collections: { messages: { target: 'Message' } },
    writableRoots: {},
  };
  const catalog = mockCatalogSnapshot({ adapters: { chat: { constructionArgs: [], schema: chat } } });
  const source = [
    'import { chat } from adapters',
    'c = connect chat',
    'function m(e: <c-[:messages]->>) {',
    '  msg = only(c-[:messages]->)',
    '  if (msg != null) {',
    '    r = await msg-[:Replies]->',
    '    said = r.Text',
    '  }',
    '}',
  ].join('\n');

  /** A chat with one message and no replies listed: what arrives on its
   *  Replies is the host's to say. */
  function quietChat(): { adapter: Adapter; reads: unknown[] } {
    const reads: unknown[] = [];
    const message = makeStablePosition({ adapterType: 'chat', recordType: 'Message', recordId: 'm-1' });
    const adapter: Adapter = {
      adapterType: 'chat',
      supportedTriggers: [],
      runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
      listEntryPoints: async () => [],
      describe: async () => null,
      resolveEntity: async () => ({ candidates: [] }),
      async getFieldValue(input) {
        reads.push([positionRecordId(input.position), input.fieldId]);
        return positionRecordId(input.position) === 'r-1' && input.fieldId === 'Text' ? 'hi' : null;
      },
      getRelated: async (read) => (read.fieldId === 'messages' ? [{ position: message }] : []),
      createRecord: async () => ({ adapterType: 'chat', externalId: 'x', data: {} }),
      updateRecord: async (input) => ({ adapterType: 'chat', externalId: input.externalId, data: {} }) as never,
      deleteRecord: async () => ({}),
      arrivals: { awaitKeys: async ({ heads }) => heads.map((head) => ({ key: `thread:${head.recordId}` })) },
    };
    return { adapter, reads };
  }

  it("opens the wait as the record enters, reads its arrivals at the await, and binds the one that counts", async () => {
    const { adapter, reads } = quietChat();
    const arrived: LoggedArrival = { seq: 42, identity: '1.5', landing: { recordId: 'r-1', recordType: 'Message', fields: { Text: 'hi', Timestamp: '1.5' } } };
    const { waits, asked } = recordingWaits({ arrivals: [arrived] });
    const park = makeFakeParkSink();
    const result = await runMovement({
      source,
      event: { pipelineInputId: 'p-1', adapterType: 'chat', triggerType: 'webhook', payload: { Text: 'hello' }, recordId: 'm-0' },
      teamId: TEAM,
      catalog,
      host: makeTestHost({ adapters: { resolve: () => adapter }, park: { waits, sink: park.sink } }),
    });
    expect(result.parked).not.toBe(true);
    expect(park.awaitParks).toEqual([]);
    const segmentId = expect.any(String);
    // The message waits on its Replies from before it entered; the await
    // reads that wait and notes the reply it binds.
    expect(asked).toEqual(
      expect.arrayContaining([
        ['mark', { segmentId }],
        ['open', { segmentId, adapterType: 'chat', edge: 'Replies', key: 'thread:m-1', since: 41 }],
        ['arrivals', { segmentId, waitId: 'wait:thread:m-1' }],
        ['note', { segmentId, waitId: 'wait:thread:m-1', identity: '1.5', matched: true }],
      ]),
    );
    // In that order: the mark before the wait opens, the wait open before
    // the await reads it, and the reading before the note.
    const order = ['mark', 'open thread:m-1', 'arrivals wait:thread:m-1', 'note wait:thread:m-1'];
    expect(inOrder(asked.map(label), order)).toEqual(order);
    expect(reads).toContainEqual(['r-1', 'Text']);
  });

  it('parks on the wait when nothing has arrived, and asks no wake when nothing arrived while it parked', async () => {
    const { adapter } = quietChat();
    const { waits } = recordingWaits({ arrivals: [] });
    const park = makeFakeParkSink();
    const wakes: QueuedWake[] = [];
    const result = await runMovement({
      source,
      event: { pipelineInputId: 'p-1', adapterType: 'chat', triggerType: 'webhook', payload: { Text: 'hello' }, recordId: 'm-0' },
      teamId: TEAM,
      catalog,
      host: makeTestHost({ adapters: { resolve: () => adapter }, park: { waits, sink: park.sink }, wakes }),
    });
    expect(result.parked).toBe(true);
    expect(park.awaitParks).toEqual([{ address: expect.any(String), state: expect.objectContaining({ version: 3 }), waitId: 'wait:thread:m-1' }]);
    expect(wakes).toEqual([]);
  });

  it('wakes the run by its wait when a reply arrived while it parked', async () => {
    const { adapter } = quietChat();
    const arrived: LoggedArrival = { seq: 43, identity: '1.5', landing: { recordId: 'r-1', recordType: 'Message', fields: { Text: 'hi', Timestamp: '1.5' } } };
    const park = makeFakeParkSink();
    // Nothing at the await's first reading; the reply lands as the run parks.
    const { waits, asked } = recordingWaits(() => ({ arrivals: park.awaitParks.length > 0 ? [arrived] : [] }));
    const wakes: QueuedWake[] = [];
    const result = await runMovement({
      source,
      event: { pipelineInputId: 'p-1', adapterType: 'chat', triggerType: 'webhook', payload: { Text: 'hello' }, recordId: 'm-0' },
      teamId: TEAM,
      catalog,
      host: makeTestHost({ adapters: { resolve: () => adapter }, park: { waits, sink: park.sink }, wakes }),
    });
    expect(result.parked).toBe(true);
    expect(park.awaitParks).toEqual([{ address: expect.any(String), state: expect.objectContaining({ version: 3 }), waitId: 'wait:thread:m-1' }]);
    expect(asked.filter(([method]) => method === 'arrivals')).toEqual([
      ['arrivals', { segmentId: expect.any(String), waitId: 'wait:thread:m-1' }],
      ['arrivals', { segmentId: expect.any(String), waitId: 'wait:thread:m-1' }],
    ]);
    expect(wakes).toEqual([{ teamId: TEAM, waitId: 'wait:thread:m-1' }]);
  });
});
