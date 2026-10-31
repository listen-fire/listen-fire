// examples/github-triage, the README's morning triage, end to end against the
// fakes its demo starts (examples/github-triage/demo/fakes.ts): the program
// checks clean; the mistaken copy is refused by name before anything runs; a
// tick posts one digest to Slack; an inbox with nothing that needs you posts
// nothing; and the schedule itself fires it under `listen-fire drain`.

import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { lf as running } from './interactive';
import { lfBinary } from './lf_bin';
import { INBOX, pointAtFakes, startFakes } from '../../../../examples/github-triage/demo/fakes';

const EXAMPLE = resolve(__dirname, '../../../../examples/github-triage');

const DIGEST = [
  '#general GitHub needs you:',
  '• acme/api: Retry webhook deliveries with backoff (review_requested) https://github.com/acme/api/pull/42',
  '• acme/api: Webhook retries double-charge on timeout (mention) https://github.com/acme/api/issues/57',
  '• acme/web: Move settings to the new layout (review_requested) https://github.com/acme/web/pull/318',
].join('\n');

/** `listen-fire <args>` in `dir`, never `spawnSync`: the fake GitHub answers from this process. */
function lf(dir: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return running(dir, args, { env }).done;
}

/** Milliseconds from now to just past the next weekday 08:30 UTC. */
function untilNextWeekdayMorning(): number {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 30));
  while (next.getTime() <= now.getTime() || next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime() + 5_000;
}

test('the github-triage example: checks clean, refuses the wrong field, posts one digest, posts nothing when nothing needs you, and fires on its schedule', async () => {
  const fakes = await startFakes();
  try {
    const dir = join(mkdtempSync(join(tmpdir(), 'lf-github-triage-')), 'github-triage');
    cpSync(EXAMPLE, dir, { recursive: true, filter: (src) => !src.startsWith(join(EXAMPLE, '.lf')) });
    await pointAtFakes(dir, fakes, { lf: lfBinary() });

    const clean = await lf(dir, ['check']);
    assert.equal(clean.code, 0, clean.out);
    assert.match(clean.out, /1 file\(s\), 0 error\(s\)/);

    cpSync(join(dir, 'mistakes/triage_wrong_field.mvt'), join(dir, 'movements/triage.mvt'));
    const wrong = await lf(dir, ['check']);
    assert.equal(wrong.code, 1, wrong.out);
    assert.match(wrong.out, /error MOV_UNKNOWN_PROPERTY gh\.Pull Request has no field 'html_url' — it has: .*HTML URL/);
    assert.match(wrong.out, /error MOV_UNKNOWN_PROPERTY gh\.Issue has no field 'html_url' — it has: .*HTML URL/);
    assert.deepEqual(fakes.github.requests, [], 'checking calls GitHub for nothing');
    cpSync(join(EXAMPLE, 'movements/triage.mvt'), join(dir, 'movements/triage.mvt'));

    const ran = await lf(dir, ['run', '--event', 'events/tick.json']);
    assert.equal(ran.code, 0, ran.out);
    assert.match(ran.out, /triage:triage completed — 1 write\(s\)/);
    assert.deepEqual(await fakes.posted(), [DIGEST]);

    // Read on github.com: nothing needs you, and nothing is posted.
    for (const thread of INBOX) fakes.github.notify({ ...thread, unread: false });
    // The next morning's tick: one tick runs a listen once, however often it is handed over.
    writeFileSync(join(dir, 'events/next_tick.json'), readFileSync(join(dir, 'events/tick.json'), 'utf8').replaceAll('2026-10-29', '2026-10-30'));
    const quiet = await lf(dir, ['run', '--event', 'events/next_tick.json']);
    assert.equal(quiet.code, 0, quiet.out);
    assert.match(quiet.out, /triage:triage completed — 0 write\(s\)/);
    assert.match(quiet.out, /returned "nothing needs you"/);
    assert.deepEqual(await fakes.posted(), [DIGEST]);

    // The schedule: the first drain owes nothing from before it; on the next
    // weekday morning the tick fires the digest.
    fakes.github.notify({ id: 'n6', reason: 'mention', repo: 'acme/api', type: 'Issue', number: 57, title: 'Webhook retries double-charge on timeout', updated_at: '2026-10-29T09:00:00Z' });
    assert.equal((await lf(dir, ['drain', '--until-idle'])).code, 0);
    assert.equal((await fakes.posted()).length, 1);
    const morning = await lf(dir, ['drain', '--until-idle'], { LF_CLOCK_AHEAD_MS: String(untilNextWeekdayMorning()) });
    assert.equal(morning.code, 0, morning.out);
    assert.match(morning.out, /triage:triage completed/);
    assert.deepEqual((await fakes.posted()).at(-1), '#general GitHub needs you:\n• acme/api: Webhook retries double-charge on timeout (mention) https://github.com/acme/api/issues/57');

    const latest = /^(\S+) /.exec((await lf(dir, ['runs'])).out)?.[1] ?? '';
    const record = JSON.parse((await lf(dir, ['runs', 'show', latest])).out) as { run?: { costMicrodollars?: number; event?: { adapterType?: string } } };
    assert.equal(record.run?.event?.adapterType, 'cron');
    assert.equal(record.run?.costMicrodollars, 0, 'no model, no cost');
  } finally {
    await fakes.stop();
  }
});
