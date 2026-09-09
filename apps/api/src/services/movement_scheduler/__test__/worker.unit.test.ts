// The movement scheduler's scan semantics — the REAL cron math
// (@listen-fire/shared/cron) over a faked trigger table and dispatch seam:
//
//   1. first sight establishes the checkpoint WITHOUT firing
//   2. an occurrence due since the checkpoint fires one tick through
//      dispatchTriggerByIdEvent (payload carries the occurrence + the
//      schedule) and advances the mark
//   3. several missed occurrences collapse into ONE tick
//   4. nothing due → no dispatch, mark untouched
//   5. an invalid schedule is tolerated (logged, never thrown) and other
//      candidates still fire
//   6. paused rows (run_mode off) are not scanned

jest.mock('../../../lib/kysely', () => {
  const rows: Array<Record<string, unknown>> = [];
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const api: any = {};
  api.selectFrom = () => api;
  api.where = () => api;
  api.select = () => api;
  api.execute = async () => rows.filter((r) => r.run_mode !== 'off');
  api.updateTable = () => {
    const update: any = { patch: {} as Record<string, unknown> };
    update.set = (p: Record<string, unknown>) => {
      update.patch = p;
      return update;
    };
    update.where = (_col: string, _op: string, id: unknown) => {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, update.patch);
      return update;
    };
    update.execute = async () => [];
    return update;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { getAutomationsQb: () => api, __rows: rows };
});

jest.mock('../../translation_graph/triggers/router', () => ({
  dispatchTriggerByIdEvent: jest.fn(async () => ({ evaluations: [], movementFirings: [] })),
}));

import { fireDueCronListeners } from '../worker';

const { __rows } = jest.requireMock('../../../lib/kysely') as {
  __rows: Array<Record<string, unknown>>;
};
const { dispatchTriggerByIdEvent } = jest.requireMock(
  '../../translation_graph/triggers/router',
) as { dispatchTriggerByIdEvent: jest.Mock };

function cronRow(input: {
  id: string;
  schedule?: string;
  timezone?: string;
  lastFiredAt?: Date | null;
  runMode?: string;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (input.schedule !== undefined) config.schedule = input.schedule;
  if (input.timezone !== undefined) config.timezone = input.timezone;
  return {
    id: input.id,
    team_id: 'team-1',
    name: `movement/file/${input.id}`,
    kind: 'cron',
    movement_id: 'mov-1',
    run_mode: input.runMode ?? 'live',
    config,
    cron_last_fired_at: input.lastFiredAt ?? null,
  };
}

beforeEach(() => {
  __rows.length = 0;
  jest.clearAllMocks();
});

const MONDAY_TEN = new Date('2026-06-08T10:00:00.000Z'); // a Monday, 10:00 UTC

describe('fireDueCronListeners', () => {
  it('first sight establishes the checkpoint without firing', async () => {
    __rows.push(cronRow({ id: 't-1', schedule: '0 9 * * 1', lastFiredAt: null }));
    await fireDueCronListeners(MONDAY_TEN);
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
    expect(__rows[0].cron_last_fired_at).toEqual(MONDAY_TEN);
  });

  it('fires one tick when an occurrence came due, carrying the occurrence + schedule', async () => {
    __rows.push(
      cronRow({
        id: 't-1',
        schedule: '0 9 * * 1',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
      }),
    );
    await fireDueCronListeners(MONDAY_TEN);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerId: 't-1',
        teamId: 'team-1',
        event: expect.objectContaining({
          adapterType: 'cron',
          triggerType: 'webhook',
          payload: {
            firedAt: '2026-06-08T09:00:00.000Z',
            schedule: '0 9 * * 1',
          },
        }),
      }),
    );
    expect(__rows[0].cron_last_fired_at).toEqual(MONDAY_TEN);
  });

  it('collapses several missed occurrences into one tick', async () => {
    // Every 15 minutes, last fired two hours ago → 8 missed occurrences.
    __rows.push(
      cronRow({
        id: 't-1',
        schedule: '*/15 * * * *',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
      }),
    );
    await fireDueCronListeners(MONDAY_TEN);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
  });

  it('does nothing when no occurrence is due', async () => {
    // Hourly schedule, checkpoint just after the 10:00 occurrence —
    // nothing comes due before 11:00.
    const justFired = new Date('2026-06-08T10:00:30.000Z');
    __rows.push(cronRow({ id: 't-1', schedule: '0 * * * *', lastFiredAt: justFired }));
    await fireDueCronListeners(new Date('2026-06-08T10:30:00.000Z'));
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
    expect(__rows[0].cron_last_fired_at).toEqual(justFired);
  });

  it('tolerates an invalid schedule and still fires the other candidates', async () => {
    __rows.push(
      cronRow({ id: 't-bad', schedule: '99 9 * * 1', lastFiredAt: new Date(0) }),
      cronRow({
        id: 't-good',
        schedule: '0 9 * * 1',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
      }),
    );
    await expect(fireDueCronListeners(MONDAY_TEN)).resolves.toBeUndefined();
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({ triggerId: 't-good' }),
    );
  });

  it('interprets a schedule in the configured timezone, tracking DST (BST → 08:00Z)', async () => {
    // `0 9 * * *` Europe/London == 09:00 LOCAL. On 6 Jul 2026 (BST, UTC+1)
    // that is 08:00Z — the worker must fire the tick at the correct instant.
    __rows.push(
      cronRow({
        id: 't-tz',
        schedule: '0 9 * * *',
        timezone: 'Europe/London',
        lastFiredAt: new Date('2026-07-06T07:00:00.000Z'),
      }),
    );
    await fireDueCronListeners(new Date('2026-07-06T08:30:00.000Z'));
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          payload: { firedAt: '2026-07-06T08:00:00.000Z', schedule: '0 9 * * *' },
        }),
      }),
    );
  });

  it('same schedule in winter (GMT) fires at 09:00Z', async () => {
    __rows.push(
      cronRow({
        id: 't-tz',
        schedule: '0 9 * * *',
        timezone: 'Europe/London',
        lastFiredAt: new Date('2026-01-05T07:00:00.000Z'),
      }),
    );
    await fireDueCronListeners(new Date('2026-01-05T09:30:00.000Z'));
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledTimes(1);
    expect(dispatchTriggerByIdEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          payload: { firedAt: '2026-01-05T09:00:00.000Z', schedule: '0 9 * * *' },
        }),
      }),
    );
  });

  it('skips paused rows (run_mode off)', async () => {
    __rows.push(
      cronRow({
        id: 't-off',
        schedule: '0 9 * * 1',
        lastFiredAt: new Date('2026-06-08T08:00:00.000Z'),
        runMode: 'off',
      }),
    );
    await fireDueCronListeners(MONDAY_TEN);
    expect(dispatchTriggerByIdEvent).not.toHaveBeenCalled();
  });
});
