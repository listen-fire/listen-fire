// The poll-source worker: scans due triggers, pulls each PollSource's events,
// injects them into the dispatch pipeline, advances the checkpoint only on
// success, and contains per-trigger failures. DB / registry / dispatch /
// event-store are mocked; the test asserts the orchestration.

import type { DiscriminableEvent } from '../../translation_graph/adapter';
import type { PollSource } from '../../translation_graph/poll_source';

// ── DB: a configurable select + a capturing update ──────────────────────────
let rows: Array<Record<string, unknown>> = [];
const updates: Array<{ id: unknown; set: Record<string, unknown> }> = [];

jest.mock('../../../lib/kysely', () => ({
  getKnowledgeQb: () => ({
    selectFrom: () => {
      const chain = {
        where: () => chain,
        select: () => chain,
        execute: async () => rows,
      };
      return chain;
    },
    updateTable: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (_col: string, _op: string, id: unknown) => ({
          execute: async () => {
            updates.push({ id, set });
          },
        }),
      }),
    }),
  }),
  getAutomationsQb: () => ({
    selectFrom: () => {
      const chain = {
        where: () => chain,
        select: () => chain,
        execute: async () => rows,
      };
      return chain;
    },
    updateTable: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (_col: string, _op: string, id: unknown) => ({
          execute: async () => {
            updates.push({ id, set });
          },
        }),
      }),
    }),
  }),
}));

// ── Registry: a fake PollSource + no adapter (skip discrimination) ───────────
const getEventsMock = jest.fn();
let pollIntervalSeconds = 300;
jest.mock('../../translation_graph/adapters/registry', () => ({
  isPollSource: (kind: string) => kind === 'granola',
  resolveAdapterSlug: (kind: string) => kind,
  hasAdapter: () => false,
  getAdapter: () => null,
  getPollSource: (): PollSource => ({
    get pollIntervalSeconds() {
      return pollIntervalSeconds;
    },
    getEvents: getEventsMock,
  }),
}));

// ── Dispatch + event store ──────────────────────────────────────────────────
const dispatchMock = jest.fn(async (_input: unknown) => ({}));
jest.mock('../../translation_graph/triggers/router', () => ({
  dispatchTriggerByIdEvent: (input: unknown) => dispatchMock(input),
}));
jest.mock('../../translation_graph/triggers/event_store', () => ({
  storeTriggerEvent: async () => 'receipt-1',
  markTriggerEventDispatched: async () => {},
  markTriggerEventFailed: async () => {},
}));

import { pollDueSources } from '../worker';

const NOW = new Date('2026-06-19T12:00:00.000Z');

function row(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 't1',
    team_id: 'team-1',
    kind: 'granola',
    config: {},
    credentials_id: 'cred-1',
    movement_id: 'mov-1',
    poll_checkpoint: undefined,
    poll_last_at: null,
    ...over,
  };
}

function event(over: Partial<DiscriminableEvent> = {}): DiscriminableEvent {
  return { payload: { title: 'Sync' }, externalId: 'note-9', tag: 'granola:note', ...over };
}

beforeEach(() => {
  rows = [];
  updates.length = 0;
  getEventsMock.mockReset();
  dispatchMock.mockReset();
  dispatchMock.mockResolvedValue({});
  pollIntervalSeconds = 300;
});

describe('pollDueSources', () => {
  it('polls a due source, dispatches each event, and advances the checkpoint', async () => {
    rows = [row()];
    getEventsMock.mockResolvedValue({
      events: [event({ externalId: 'a' }), event({ externalId: 'b' })],
      checkpoint: { updatedAfter: '2026-06-19T11:59:00Z' },
    });

    await pollDueSources(NOW);

    expect(getEventsMock).toHaveBeenCalledWith({ config: {}, checkpoint: undefined });
    expect(dispatchMock).toHaveBeenCalledTimes(2);
    // checkpoint + poll_last_at advanced once, after the pull.
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe('t1');
    expect(updates[0].set.poll_last_at).toBe(NOW);
  });

  it('skips a source that is not yet due (poll_last_at within the interval)', async () => {
    rows = [row({ poll_last_at: new Date(NOW.getTime() - 60_000) })]; // 60s ago, interval 300s
    await pollDueSources(NOW);
    expect(getEventsMock).not.toHaveBeenCalled();
    expect(updates).toHaveLength(0);
  });

  it('honours a per-trigger interval override from config (P4)', async () => {
    // 60s since last poll; default 300s would skip, but config says every 30s.
    rows = [row({ poll_last_at: new Date(NOW.getTime() - 60_000), config: { pollIntervalSeconds: 30 } })];
    getEventsMock.mockResolvedValue({ events: [], checkpoint: null });
    await pollDueSources(NOW);
    expect(getEventsMock).toHaveBeenCalled();
  });

  it('does NOT advance the checkpoint when the pull throws', async () => {
    rows = [row()];
    getEventsMock.mockRejectedValue(new Error('granola 500'));
    await pollDueSources(NOW);
    expect(updates).toHaveLength(0); // left untouched → retried next scan
  });

  it('contains a per-trigger failure — other sources still poll', async () => {
    rows = [row({ id: 'bad' }), row({ id: 'good' })];
    getEventsMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ events: [event()], checkpoint: { updatedAfter: 'x' } });
    await pollDueSources(NOW);
    expect(getEventsMock).toHaveBeenCalledTimes(2);
    expect(updates.map((u) => u.id)).toEqual(['good']); // only the healthy one advanced
  });

  it('ignores triggers whose kind is not a registered PollSource', async () => {
    rows = [row({ kind: 'attio' })];
    await pollDueSources(NOW);
    expect(getEventsMock).not.toHaveBeenCalled();
  });
});
