// Which slots' modules a session starts as it opens: `lf drain` starts every
// slot a process module fills, together with the externals, so no run waits
// on a module's start; `lf serve --doors-only` starts only the slots a door
// calls (the limiter, the wake), never the models; a one-shot command
// starts a slot's module at its first call, as ever.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { lfBinary } from './lf_bin';
import { project, served } from './example';

const FAKES = resolve(__dirname);
const SLOTS = [
  { name: 'acme_llm', slot: 'models', serve: 'models_module/serve.ts' },
  { name: 'acme_limits', slot: 'limiter', serve: 'limiter_module/serve.ts' },
  { name: 'acme_wake', slot: 'wake', serve: 'wake_module/serve.ts' },
];

/** Where wake deliveries go: nowhere that answers, as no test here counts them. */
const ENV = { NODE_NO_WARNINGS: '1', LF_SECRET__ACME_WAKE__EXTERNAL: 'acme_wake', LF_SECRET__ACME_WAKE__TARGET: 'http://127.0.0.1:9/' };

/** The example project with the three fake slot modules, each noting its
 *  start in `started/<name>` first; the models module takes a second. */
function withSlots(): string {
  const dir = project();
  mkdirSync(join(dir, 'started'));
  for (const { name, slot, serve } of SLOTS) {
    mkdirSync(join(dir, 'externals', name), { recursive: true });
    const node = [process.execPath, '--conditions=movement-engine-internals', '--require', require.resolve('tsx/cjs'), join(FAKES, serve)].map((p) => JSON.stringify(p)).join(' ');
    const pause = slot === 'models' ? 'sleep 1; ' : '';
    const script = `date +%s >> ${JSON.stringify(join(dir, 'started', name))}; ${pause}exec ${node}`;
    const settings = slot === 'wake' ? ['settings:', '  - { name: target, label: where a wake is delivered }'] : [];
    writeFileSync(join(dir, 'externals', name, 'lf-external.yaml'), [`name: ${name}`, 'kind: core', `slot: ${slot}`, `command: [sh, -c, ${JSON.stringify(script)}]`, ...settings, ''].join('\n'));
  }
  appendFileSync(join(dir, 'lf.yaml'), `\ncore:\n${SLOTS.map((s) => `  ${s.slot}: ${s.name}`).join('\n')}\n`);
  return dir;
}

function started(dir: string): string[] {
  return SLOTS.map((s) => s.name).filter((name) => existsSync(join(dir, 'started', name)));
}

function lfIn(dir: string, ...args: string[]): { code: number; out: string } {
  const run = spawnSync(lfBinary(), args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...ENV } });
  return { code: run.status ?? -1, out: `${run.stdout}${run.stderr}` };
}

test('lf drain starts every slot module as it opens, the slow one with the rest', () => {
  const dir = withSlots();
  const opened = Date.now();
  const drained = lfIn(dir, 'drain', '--until-idle');
  assert.equal(drained.code, 0, drained.out);
  assert.deepEqual(started(dir), ['acme_llm', 'acme_limits', 'acme_wake'], 'models too, though no run called it');
  const at = (name: string) => Number(readFileSync(join(dir, 'started', name), 'utf8').trim().split('\n')[0]);
  assert.ok(Math.abs(at('acme_llm') - at('acme_wake')) <= 1, 'started together');
  assert.ok(Date.now() - opened < 10_000);
});

test('a one-shot command starts a slot module only at its first call', () => {
  const dir = withSlots();
  const ran = lfIn(dir, 'run', '--event', 'events/company_created.json', '--dry-run');
  assert.equal(ran.code, 0, ran.out);
  assert.ok(!started(dir).includes('acme_llm'), 'no model call, no models module');
});

test('lf serve --doors-only starts the slots a door calls, never the models', async () => {
  const dir = withSlots();
  const server = await served(dir, ['--doors-only'], ENV);
  try {
    assert.deepEqual(started(dir), ['acme_limits', 'acme_wake']);
  } finally {
    await server.stop();
  }
});
