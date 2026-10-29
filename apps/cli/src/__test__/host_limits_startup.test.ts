// A module that declares `hostLimits` asks listen-fire's limits door before each
// request to its provider, and may make one while listen-fire describes its
// connection as a session opens (host_limits_module, as `@lf/mcp` lists a
// server's tools). The door must answer then: `listen-fire serve`, `listen-fire serve
// --doors-only` and `listen-fire drain` become ready, and the door granted the
// describe's request, rather than listen-fire waiting on the module while the module
// waits on a door listen-fire does not yet serve.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { lfCommand, project, served } from './example';

/** Ready well inside this; a deadlocked start never is. */
const READY_MS = 10_000;

function notesProject(): string {
  const dir = project();
  const folder = join(dir, 'externals/notes');
  mkdirSync(folder);
  copyFileSync(resolve(__dirname, 'host_limits_module/serve.mjs'), join(folder, 'serve.mjs'));
  writeFileSync(join(folder, 'lf-external.yaml'), 'name: notes\nkind: adapter\ncommand: [node, serve.mjs]\n');
  const secretsPath = join(dir, '.lf/secrets.yaml');
  const secrets = parse(readFileSync(secretsPath, 'utf8')) as Record<string, unknown>;
  secrets.alpha_notes = { module: 'notes', credential: 'workspace', workspace: 'alpha' };
  writeFileSync(secretsPath, stringify(secrets), { mode: 0o600 });
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(
    join(dir, 'movements/notes.mvt'),
    `import { acme_crm, notes } from adapters
import { acme, alpha_notes } from credentials

crm = connect acme_crm using acme
alpha = connect notes using alpha_notes

function note(company: <crm-[:Company]->>) {
  write alpha-[:Note]-> { Title: company.Name }
}

listen to crm { events: ["company.created"] } fire note
`,
  );
  return dir;
}

function doorAnswers(dir: string): Array<{ method: string; op: string; status: number; body: { outcome?: string } }> {
  const file = join(dir, 'externals/notes/door.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

/** The describe at startup asked the door and was granted. */
function describeWasGranted(dir: string): void {
  const answers = doorAnswers(dir);
  const acquire = answers.find((a) => a.method === 'describe' && a.op === 'acquire');
  assert.ok(acquire !== undefined, `the describe never asked the door: ${JSON.stringify(answers)}`);
  assert.deepEqual([acquire.status, acquire.body.outcome], [200, 'granted']);
}

for (const args of [[], ['--doors-only']]) {
  test(`${['listen-fire serve', ...args].join(' ')}: a module asking the limits door while it is described at startup does not hold the start`, async () => {
    const dir = notesProject();
    const started = Date.now();
    const serving = await served(dir, args);
    try {
      const took = Date.now() - started;
      assert.ok(took < READY_MS, `listen-fire serve became ready after ${took} ms`);
      describeWasGranted(dir);
    } finally {
      await serving.stop();
    }
  });
}

test('listen-fire drain --until-idle: a module asking the limits door while it is described at open does not hold the worker', async () => {
  const dir = notesProject();
  const drain = spawn(...lfCommand(['drain', '--until-idle']), { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  drain.stdout!.on('data', (c) => (out += c));
  drain.stderr!.on('data', (c) => (out += c));
  const code = await new Promise<number | 'timeout'>((done) => {
    const timer = setTimeout(() => (drain.kill('SIGKILL'), done('timeout')), READY_MS);
    drain.once('exit', (c) => (clearTimeout(timer), done(c ?? -1)));
  });
  assert.equal(code, 0, out);
  describeWasGranted(dir);
});
