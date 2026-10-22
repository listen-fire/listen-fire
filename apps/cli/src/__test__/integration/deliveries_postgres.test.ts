// The delivery receipt over a Postgres store: `lf serve --doors-only` keeps a
// signed webhook once however often it is sent, a worker (`lf drain`) runs it
// with the run naming its delivery, a replay runs again, and the drain forgets
// the settled deliveries after their days. Needs a Postgres (pg.ts) and psql.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lfCommand, served } from '../example';
import { COMPLETING, type DeliveryDoc, post, receiptProject } from '../deliveries_fixture';
import { freshTeam, POSTGRES_URL, psql } from './pg';

test('a doors-only serve keeps a webhook once, a worker runs it, and a replay runs it again', async () => {
  const { team, clear } = freshTeam();
  const store = ['--store', POSTGRES_URL, '--team', team];
  const dir = receiptProject(COMPLETING);
  const lfStore = (...args: string[]): string => {
    const run = spawnSync(...lfCommand([...args, ...store]), { cwd: dir, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    assert.equal(run.status, 0, `${args.join(' ')}: ${run.stdout}${run.stderr}`);
    return run.stdout;
  };
  const deliveries = (): DeliveryDoc[] => (JSON.parse(lfStore('deliveries', '--json')) as { deliveries: DeliveryDoc[] }).deliveries;
  try {
    const serving = await served(dir, ['--doors-only', ...store]);
    try {
      const first = await post(serving.port, dir, 'd-1');
      assert.equal(first.status, 202);
      assert.equal(first.answer.runs, undefined);
      const second = await post(serving.port, dir, 'd-1');
      assert.equal(second.status, 202);
      assert.equal(second.answer.duplicate, true);
    } finally {
      await serving.stop();
    }
    // Kept once, with its event queued and no run yet: the doors-only serve runs nothing.
    assert.deepEqual(psql(`select count(*) from lf.delivery where team_id = '${team}'`), [['1']]);
    assert.deepEqual(psql(`select count(*) from lf.trigger_run where team_id = '${team}'`), [['0']]);

    lfStore('drain', '--until-idle');
    const [deliveryId] = psql(`select id, external_id from lf.delivery where team_id = '${team}'`)[0] ?? [];
    assert.ok(deliveryId);
    assert.deepEqual(psql(`select delivery_id from lf.trigger_run where team_id = '${team}'`), [[deliveryId]]);

    lfStore('deliveries', 'replay', deliveryId);
    lfStore('drain', '--until-idle');
    assert.deepEqual(psql(`select count(*) from lf.trigger_run where team_id = '${team}'`), [['2']]);
    const [newer, older] = deliveries();
    assert.equal(older?.id, deliveryId);
    assert.equal(older?.externalId, 'd-1');
    assert.equal(newer?.replayOf, deliveryId);
    assert.equal(newer?.runs.length, 1);

    // Settled and past their days (14 by default): the drain forgets both receipts, not their runs.
    psql(`update lf.delivery set received_at = now() - interval '30 days' where team_id = '${team}'`);
    lfStore('drain', '--until-idle');
    assert.deepEqual(psql(`select count(*) from lf.delivery where team_id = '${team}'`), [['0']]);
    assert.deepEqual(psql(`select count(*) from lf.trigger_run where team_id = '${team}'`), [['2']]);
  } finally {
    clear();
  }
});
