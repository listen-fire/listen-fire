// The loop guard slot is removed (0.14.0): a project that still names one,
// in lf.yaml's `core:` or as a module's slot, is refused by name, with what
// replaces it, by `listen-fire check` and by `listen-fire run`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lf, project } from './example';

const REMEDY = "the loop guard slot is retired: remove it; the loop breaker (lf.yaml's loopWindow and loopDepth) replaces it";

test("an lf.yaml naming core.loopGuard is refused by name, by check and by run", () => {
  const dir = project();
  appendFileSync(join(dir, 'lf.yaml'), 'core:\n  loopGuard: "@lf/fingerprint-guard"\n');
  for (const args of [['check'], ['run', '--event', 'events/company_created.json']]) {
    const refused = lf(dir, ...args);
    assert.notEqual(refused.code, 0, refused.out);
    assert.ok(refused.out.includes(`core.loopGuard: ${REMEDY}`), refused.out);
  }
});

test('a core module that fills the loopGuard slot is refused by name', () => {
  const dir = project();
  mkdirSync(join(dir, 'externals/acme_guard'), { recursive: true });
  writeFileSync(join(dir, 'externals/acme_guard/lf-external.yaml'), 'name: acme_guard\nkind: core\nslot: loopGuard\ncommand: [node, serve.mjs]\n');
  const refused = lf(dir, 'check');
  assert.notEqual(refused.code, 0, refused.out);
  assert.ok(refused.out.includes(`slot: loopGuard: ${REMEDY}`), refused.out);
  assert.match(refused.out, /acme_guard/);
});
