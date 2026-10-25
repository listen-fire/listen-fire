// `lf --version`: the first line is `lf <version>` (Homebrew's test and the
// upgrade tests read it), then the adapter protocol range lf speaks, then the
// modules bundled beside it with the versions they carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { lfCommand } from './example';

function version(env: Record<string, string>): string[] {
  const run = spawnSync(...lfCommand(['--version']), { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trimEnd().split('\n');
}

test('lf --version starts with lf <version>, names the protocol range, and lists the bundled modules from VERSIONS', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'lf-bundle-'));
  writeFileSync(join(bundle, 'VERSIONS'), '@listen-fire/slack 0.12.7\nmodule-kit 0.12.6\n');
  const lines = version({ LF_MODULES_DIR: bundle });
  assert.match(lines[0], /^lf \d+\.\d+\.\d+/);
  assert.match(lines[1], /^adapter protocol 2\.0–2\.\d+$/);
  assert.equal(lines[2], `bundled modules (${bundle}):`);
  assert.deepEqual(lines.slice(3), ['  @listen-fire/slack 0.12.7', '  module-kit 0.12.6']);
});

test('without a VERSIONS file, lf --version reads each bundled folder\'s package.json', () => {
  const bundle = mkdtempSync(join(tmpdir(), 'lf-bundle-'));
  mkdirSync(join(bundle, 'slack'));
  writeFileSync(join(bundle, 'slack', 'package.json'), JSON.stringify({ name: '@listen-fire/slack', version: '0.12.9' }));
  const lines = version({ LF_MODULES_DIR: bundle });
  assert.match(lines[0], /^lf \d/);
  assert.ok(lines.includes('  @listen-fire/slack 0.12.9'), lines.join('\n'));
});
