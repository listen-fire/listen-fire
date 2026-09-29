// System adapter — the platform as a source. Covers the surface an author
// reads (four fires edges, one record shape, nothing readable or writable), the
// Run Failed emission from a failed run, and the rule that keeps a failure
// handler from reporting itself. No database: the failed-run reader is faked.

jest.mock('../../../../logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
// The DB reader is replaced in every test; stub the accessor so the module
// graph never opens a connection.
jest.mock('../../../../../lib/kysely', () => ({ getAutomationsQb: jest.fn() }));

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import { makeMetaPosition, makeUnstablePosition } from '../../../types';
import { SYSTEM_ADAPTER_TYPE, SYSTEM_MANIFEST, SystemAdapter } from '../index';
import {
  SystemPollSource,
  type FailedRun,
  type FailedRunReader,
  type SystemCheckpoint,
} from '../poll';
import { RUN_FAILED, SYSTEM_EVENT_KINDS, type SystemEventPayload } from '../types';

const TEAM = 'team-1' as TeamId;
const NOW = new Date('2026-09-29T12:00:00.000Z');
const MARK = { failedAt: '2026-09-29T11:50:00.000Z', runId: '00000000-0000-0000-0000-000000000000' };

const NAMES = ['Run Failed', 'Validation Issue', 'Deprecated Version', 'Release Applied'];
const FIELDS = ['Automation', 'Automation Id', 'Run Id', 'Version', 'Reason', 'Url', 'At'];

function failedRun(over: Partial<FailedRun> = {}): FailedRun {
  return {
    runId: 'run-1',
    automation: { id: 'mov-crm', name: 'Sync CRM' },
    reason: 'Attio refused the write: 403',
    failedAt: new Date('2026-09-29T11:55:00.000Z'),
    ...over,
  };
}

function source(runs: FailedRun[]): { poll: SystemPollSource; reader: jest.Mock } {
  const reader = jest.fn<ReturnType<FailedRunReader>, Parameters<FailedRunReader>>(
    async () => runs,
  );
  return { poll: new SystemPollSource(TEAM, reader, () => NOW), reader };
}

describe('SystemAdapter surface', () => {
  const adapter = new SystemAdapter(TEAM);

  it('declares four fires edges, each selected by its own natural name', async () => {
    const entries = await adapter.listEntryPoints();
    expect(entries.map((e) => e.displayName)).toEqual(NAMES);
    for (const entry of entries) {
      expect(entry).toMatchObject({ fires: true, readable: false, writable: false });
      expect(entry.firesOn).toEqual([entry.displayName]);
    }
    expect(SYSTEM_MANIFEST.subscribableEvents).toEqual(NAMES);
    expect(SYSTEM_MANIFEST.defaultSubscribedEvents).toEqual(['Run Failed']);
  });

  it('is read-only and credential-free', () => {
    expect(SYSTEM_MANIFEST.requiredCredentialType).toBeUndefined();
    expect(SYSTEM_MANIFEST.methods).not.toEqual(
      expect.arrayContaining(['createRecord']),
    );
    expect(SYSTEM_MANIFEST.supportedTriggers).toEqual(['poll']);
  });

  it('roots every kind as a fires edge and nothing else', async () => {
    const root = await adapter.edgesFrom(makeMetaPosition(SYSTEM_ADAPTER_TYPE));
    const refs = root?.descriptor.references ?? [];
    expect(refs.map((r) => r.name)).toEqual(NAMES);
    for (const ref of refs) expect(ref).toMatchObject({ fires: true, readable: false, writable: false });
  });

  it('lands every kind on the same record shape', async () => {
    for (const name of NAMES) {
      const descriptor = await adapter.describe(name);
      expect(descriptor?.displayName).toBe(name);
      expect(descriptor?.fields.map((f) => f.displayName)).toEqual(FIELDS);
      expect(descriptor?.fields.every((f) => f.writable === false)).toBe(true);
      expect(descriptor?.references).toEqual([]);
    }
  });

  it('says in the schema that three kinds wait on the deploy check', async () => {
    for (const kind of SYSTEM_EVENT_KINDS.filter((k) => k !== RUN_FAILED)) {
      expect((await adapter.describe(kind.typeId))?.description).toContain(
        'Emitted by the deploy check from the next release',
      );
    }
  });

  it('discriminates by tag onto each kind', async () => {
    expect(await adapter.listEventTypes()).toEqual(
      SYSTEM_EVENT_KINDS.map((k) => ({ tag: k.tag, positionType: k.typeId })),
    );
  });

  it('reads a field by its natural name off the delivered record', async () => {
    const position = makeUnstablePosition({
      adapterType: SYSTEM_ADAPTER_TYPE,
      recordType: 'Run Failed',
      data: { reason: 'boom', url: 'http://x/movements/m' },
    });
    expect(await adapter.getFieldValue({ position, fieldId: 'Reason' })).toBe('boom');
    expect(await adapter.getFieldValue({ position, fieldId: 'Url' })).toBe('http://x/movements/m');
  });
});

describe('Run Failed emission', () => {
  it('first poll sets the mark behind the settle window and emits nothing', async () => {
    const { poll, reader } = source([failedRun()]);
    const result = await poll.getEvents({ config: {}, movementId: 'mov-alerts' });
    expect(result.events).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
    const mark = (result.checkpoint as SystemCheckpoint).runFailed;
    expect(mark?.failedAt).toBe('2026-09-29T11:59:50.000Z');
  });

  it('turns a failed run into a Run Failed record and advances the mark past it', async () => {
    const run = failedRun();
    const { poll, reader } = source([run]);
    const result = await poll.getEvents({
      config: { events: ['Run Failed'] },
      checkpoint: { runFailed: MARK },
      movementId: 'mov-alerts',
    });

    expect(reader).toHaveBeenCalledWith({
      teamId: TEAM,
      after: MARK,
      until: new Date('2026-09-29T11:59:50.000Z'),
      limit: 100,
    });
    expect(result.events).toHaveLength(1);
    const [event] = result.events;
    expect(event).toMatchObject({
      tag: RUN_FAILED.tag,
      externalId: 'run-1',
      idempotencyKey: 'system:run_failed:run-1',
      occurredAt: '2026-09-29T11:55:00.000Z',
    });
    const payload = event.payload as SystemEventPayload;
    expect(payload).toMatchObject({
      automation: 'Sync CRM',
      automationId: 'mov-crm',
      runId: 'run-1',
      version: '',
      reason: 'Attio refused the write: 403',
      at: '2026-09-29T11:55:00.000Z',
    });
    expect(payload.url).toMatch(/\/movements\/mov-crm\?view=activity&status=failed$/);
    expect((result.checkpoint as SystemCheckpoint).runFailed).toEqual({
      failedAt: '2026-09-29T11:55:00.000Z',
      runId: 'run-1',
    });
  });

  it('never tells an automation about its own failure, but still moves past it', async () => {
    const own = failedRun({ runId: 'run-own', automation: { id: 'mov-alerts', name: 'Alerts' } });
    const other = failedRun({ runId: 'run-other', failedAt: new Date('2026-09-29T11:56:00.000Z') });
    const { poll } = source([own, other]);
    const result = await poll.getEvents({
      config: {},
      checkpoint: { runFailed: MARK },
      movementId: 'mov-alerts',
    });
    expect(result.events.map((e) => e.externalId)).toEqual(['run-other']);

    // The handler's own failure is the LAST run: nothing is delivered, and the
    // mark still passes it so it is never reconsidered.
    const { poll: onlyOwn } = source([own]);
    const ownResult = await onlyOwn.getEvents({
      config: {},
      checkpoint: { runFailed: MARK },
      movementId: 'mov-alerts',
    });
    expect(ownResult.events).toEqual([]);
    expect((ownResult.checkpoint as SystemCheckpoint).runFailed?.runId).toBe('run-own');
  });

  it('passes a run no automation owns without delivering it', async () => {
    const { poll } = source([failedRun({ runId: 'run-legacy', automation: null })]);
    const result = await poll.getEvents({ config: {}, checkpoint: { runFailed: MARK } });
    expect(result.events).toEqual([]);
    expect((result.checkpoint as SystemCheckpoint).runFailed?.runId).toBe('run-legacy');
  });

  it('keeps the mark when nothing new failed', async () => {
    const { poll } = source([]);
    const result = await poll.getEvents({ config: {}, checkpoint: { runFailed: MARK } });
    expect((result.checkpoint as SystemCheckpoint).runFailed).toEqual(MARK);
  });

  it('reads nothing for a listen on a kind nothing emits yet', async () => {
    const { poll, reader } = source([failedRun()]);
    const result = await poll.getEvents({
      config: { events: ['Validation Issue'] },
      checkpoint: { runFailed: MARK },
    });
    expect(result.events).toEqual([]);
    expect(reader).not.toHaveBeenCalled();
  });
});
