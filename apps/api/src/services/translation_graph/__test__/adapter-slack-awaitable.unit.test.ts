// The Slack adapter's AWAITABLE capability (asks-as-adapter §A/D, S18) — the
// proof the capability isn't ask-shaped. Pins the parts that need no live Slack
// client or DB: the correlation key (`channel:thread_ts`), register/drop routing
// into the generic correlation map, the edge-name guard, and the WHERE CANDIDATE
// SURFACE (a landing reads back through the ordinary message `getFieldValue`, so
// the engine's pure WHERE over `o.User` / `o.`Message`` resolves without knowing
// any of Slack's internal keys). The live thread re-check (`resolveAwait`
// against `conversations.replies`) and the DB-backed map are covered e2e in the
// dev loop.

const registerAwaitCorrelationMock = jest.fn();
const dropAwaitCorrelationMock = jest.fn();

jest.mock('../adapters/await_correlation', () => ({
  registerAwaitCorrelation: (...a: unknown[]) => registerAwaitCorrelationMock(...a),
  dropAwaitCorrelation: (...a: unknown[]) => dropAwaitCorrelationMock(...a),
}));

import { SlackAdapter, SLACK_MESSAGE_TYPE_ID } from '../adapters/slack';
import { makeUnstablePosition } from '../types';
import type { TeamId } from '../../../generated/kysely/core/Team';

const TEAM_ID = 'team-1' as TeamId;

function makeAdapter(): SlackAdapter {
  return new SlackAdapter(TEAM_ID);
}

beforeEach(() => {
  registerAwaitCorrelationMock.mockReset();
  dropAwaitCorrelationMock.mockReset();
});

describe('SlackAdapter.awaitable — correlation key', () => {
  it('derives channel:thread_ts from a top-level message write handle (thread root = its own ts)', () => {
    const adapter = makeAdapter();
    // A `write ch-[:Messages]->` handle: externalId is the bare ts, channel rides
    // the write-result data as `channelId` — no thread_ts, so the reply lands
    // under the message's own ts.
    const key = adapter.replyCorrelationKey('1700000000.000100', {
      channelId: 'C123',
      ts: '1700000000.000100',
    });
    expect(key).toBe('C123:1700000000.000100');
  });

  it('anchors to the THREAD ROOT when the awaited message is itself a reply', () => {
    const adapter = makeAdapter();
    const key = adapter.replyCorrelationKey('1700000000.000200', {
      channelId: 'C123',
      ts: '1700000000.000200',
      threadTs: '1700000000.000000',
    });
    expect(key).toBe('C123:1700000000.000000');
  });

  it('is null when the channel cannot be recovered (no correlation possible)', () => {
    const adapter = makeAdapter();
    expect(adapter.replyCorrelationKey('1700000000.000100', {})).toBeNull();
    expect(adapter.replyCorrelationKey('1700000000.000100', undefined)).toBeNull();
  });
});

describe('SlackAdapter.awaitable — register / drop', () => {
  it('registerAwait writes an adapter_type=slack correlation keyed on channel:thread_ts', async () => {
    const adapter = makeAdapter();
    await adapter.awaitable.registerAwait({
      recordId: '1700000000.000100',
      edge: 'Replies',
      headData: { channelId: 'C123', ts: '1700000000.000100' },
      runId: 'run-1',
      teamId: TEAM_ID,
      address: 'ROOT.stmt 1',
    });
    expect(registerAwaitCorrelationMock).toHaveBeenCalledWith({
      adapterType: 'slack',
      correlationKey: 'C123:1700000000.000100',
      runId: 'run-1',
      teamId: TEAM_ID,
      address: 'ROOT.stmt 1',
    });
  });

  it('registerAwait refuses loudly when the message channel is missing (uncorrelatable)', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.awaitable.registerAwait({
        recordId: '1700000000.000100',
        edge: 'Replies',
        runId: 'run-1',
        teamId: TEAM_ID,
        address: 'ROOT.stmt 1',
      }),
    ).rejects.toThrow(/cannot|channel/i);
    expect(registerAwaitCorrelationMock).not.toHaveBeenCalled();
  });

  it('dropCorrelation drops the one park by (run, address) — adapter-agnostic', async () => {
    const adapter = makeAdapter();
    await adapter.awaitable.dropCorrelation({ runId: 'run-1', address: 'ROOT.stmt 1' });
    expect(dropAwaitCorrelationMock).toHaveBeenCalledWith({
      runId: 'run-1',
      address: 'ROOT.stmt 1',
    });
  });
});

describe('SlackAdapter.awaitable — edge guard', () => {
  it('resolveAwait rejects an edge that is not Replies', async () => {
    const adapter = makeAdapter();
    await expect(
      adapter.awaitable.resolveAwait({ recordId: '1700000000.1', edge: 'Author' }),
    ).rejects.toThrow(/not an awaitable edge/);
  });
});

describe('SlackAdapter.awaitable — WHERE candidate surface', () => {
  it('a landing reads its reply fields back through the ordinary message getFieldValue', async () => {
    const adapter = makeAdapter();
    // The landing the resume path binds: recordType = the natural Message type,
    // data = the raw reply payload (what resolveAwait returns). The engine's pure
    // WHERE (`o.User == "U9"`) reads each candidate THROUGH this same
    // getFieldValue — so it must surface the reply's author and body under the
    // author-facing field names.
    const landing = makeUnstablePosition({
      adapterType: 'slack',
      recordType: 'Message',
      data: {
        text: 'Please hold off',
        user: 'U9',
        channel: 'C123',
        ts: '1700000000.000200',
      },
    });
    expect(await adapter.getFieldValue({ position: landing, fieldId: 'Message' })).toBe(
      'Please hold off',
    );
    expect(await adapter.getFieldValue({ position: landing, fieldId: 'User' })).toBe('U9');
    expect(await adapter.getFieldValue({ position: landing, fieldId: 'Channel' })).toBe('C123');
  });
});

// Reference the message type id so a rename of the constant fails this test loudly.
it('the awaitable Replies edge targets the Message type', () => {
  expect(SLACK_MESSAGE_TYPE_ID).toBe('slack:message');
});
