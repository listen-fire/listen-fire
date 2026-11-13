// Run from anywhere: node scripts/release/release-menu/test/approve-npm-stages.test.mjs
// Proves the matching rule and the exit statuses of approve-npm-stages.mjs over a fake npm and a fixture in the shape of npm's `stage list --json`.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: here, encoding: 'utf8' }).trim();
const script = join(root, 'scripts/release/approve-npm-stages.mjs');

const manifest = JSON.parse(readFileSync(join(root, 'packages/movement-lang/package.json'), 'utf8'));
const item = (id, packageName, version, tag = 'latest') => ({ id, packageName, version, tag, status: 'pending', createdAt: '2026-11-13T09:00:00.000Z', actor: 'someone', actorType: 'user', shasum: 'abc' });
const dir = mkdtempSync(join(tmpdir(), 'lf-approve-test-'));
const stages = join(dir, 'stages.json');
writeFileSync(stages, JSON.stringify([
  item('11111111-1111-4111-8111-111111111111', manifest.name, manifest.version),
  item('22222222-2222-4222-8222-222222222222', manifest.name, '99.0.0'),
  item('33333333-3333-4333-8333-333333333333', '@someone-else/pkg', manifest.version, 'next'),
]));

const run = (mode, args = [], env = {}) => spawnSync('node', [script, ...args], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, LF_NPM: `node ${join(here, 'fake-npm.mjs')}`, FAKE_STAGES: stages, FAKE_MODE: mode, npm_config_otp: '', ...env },
});

let result = run('ok', ['--list']);
assert.equal(result.status, 0);
assert.match(result.stdout, new RegExp(`^${manifest.name}@${manifest.version} \\(latest\\)$`, 'm'));
assert.match(result.stdout, /left out: .*@99\.0\.0/);
assert.match(result.stdout, /left out: @someone-else\/pkg/);
assert.equal(result.stdout.split('\n').filter((line) => /^\S+@\S+ \(.*\)$/.test(line) && !line.startsWith('left out')).length, 1);

result = run('ok');
assert.equal(result.status, 0);
assert.match(result.stdout, /approved: /);
assert.doesNotMatch(result.stdout, /99\.0\.0.*approved|someone-else.*approved/);

result = run('eotp');
assert.equal(result.status, 3, 'a missing code is exit 3');
result = run('eotp', [], { npm_config_otp: '000000' });
assert.equal(result.status, 3, 'a rejected code is exit 3');
result = run('eotp', [], { npm_config_otp: '123456' });
assert.equal(result.status, 0, 'the accepted code approves');

result = run('e401', ['--list']);
assert.equal(result.status, 4, 'not signed in is exit 4');

writeFileSync(stages, '[]');
result = run('ok');
assert.equal(result.status, 0);
assert.match(result.stdout, /nothing staged/);

assert.equal(run('ok', ['--bogus']).status, 2);
console.log('approve-npm-stages: all checks passed');
