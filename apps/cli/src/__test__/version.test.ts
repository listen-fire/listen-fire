// `listen-fire --version`: the first line is `listen-fire <version>` (Homebrew's test and the
// upgrade tests read it), then the adapter protocol range listen-fire speaks, then the
// modules bundled beside it with the versions they carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RELEASE_RE } from './release';
import { lf, lfCommand, project } from './example';

function version(env: Record<string, string>): string[] {
  const run = spawnSync(...lfCommand(['--version']), { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trimEnd().split('\n');
}

test('listen-fire --version starts with listen-fire <version>, names the protocol range, and lists the bundled modules from VERSIONS', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'lf-bundle-'));
  writeFileSync(join(bundle, 'VERSIONS'), '@listen-fire/slack 0.12.7\nmodule-kit 0.12.6\n');
  const lines = version({ LF_MODULES_DIR: bundle });
  assert.match(lines[0], /^listen-fire \d+\.\d+\.\d+/);
  assert.match(lines[1], /^adapter protocol 2\.0–2\.\d+$/);
  assert.equal(lines[2], `bundled modules (${bundle}):`);
  assert.deepEqual(lines.slice(3), ['  @listen-fire/slack 0.12.7', '  module-kit 0.12.6']);
});

test('without a VERSIONS file, listen-fire --version reads each bundled folder\'s package.json', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'lf-bundle-'));
  mkdirSync(join(bundle, 'slack'));
  writeFileSync(join(bundle, 'slack', 'package.json'), JSON.stringify({ name: '@listen-fire/slack', version: '0.12.9' }));
  const lines = version({ LF_MODULES_DIR: bundle });
  assert.match(lines[0], /^listen-fire \d/);
  assert.ok(lines.includes('  @listen-fire/slack 0.12.9'), lines.join('\n'));
});

test('a project pinned to 0.12 is refused by name and upgrade moves its pin to this release', () => {
  const dir = project();
  writeFileSync(join(dir, 'lf.yaml'), readFileSync(join(dir, 'lf.yaml'), 'utf8').replace(/^engine: .*$/m, 'engine: 0.12.13'));
  const checked = lf(dir, 'check');
  assert.equal(checked.code, 1, checked.out);
  assert.match(checked.out, new RegExp(String.raw`lf\.yaml pins engine 0\.12\.13, which this listen-fire \(${RELEASE_RE}\) does not read; run \`listen-fire upgrade\``));
  assert.equal(lf(dir, 'upgrade').code, 0);
  assert.match(readFileSync(join(dir, 'lf.yaml'), 'utf8'), new RegExp(String.raw`^engine: ${RELEASE_RE}$`, 'm'));
});
