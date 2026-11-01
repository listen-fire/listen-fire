// The fields only a polled source can judge — Dealroom's company terms,
// Evertrace's saved search and list name — checked as a person types them:
// a WHERE the module takes checks clean, on a walk and on a listen; a
// comparison it can't take is refused where it is written, never left to
// read empty on the host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { lf, project } from './example';
import { lf as lfAsked, ok } from './interactive';

async function connected(module: string): Promise<{ dir: string; file: string }> {
  const dir = project();
  rmSync(join(dir, 'movements', 'companies.mvt'));
  await ok(lfAsked(dir, ['connect', `@lf/${module}`, '--yes'], { answers: [] }));
  await ok(lfAsked(dir, ['credential', 'add', '--module', module, `${module}_key`], { answers: ['test-key', ''] }));
  return { dir, file: join(dir, 'movements', 'sources.mvt') };
}

const program = (module: string, body: string) =>
  [`import { ${module} } from adapters`, `import { ${module}_key } from credentials`, '', `source = connect ${module} using ${module}_key`, '', body, ''].join('\n');

/** The codes `listen-fire check` reports for `body`. */
function codes(dir: string, file: string, module: string, body: string): string[] {
  writeFileSync(file, program(module, body));
  const checked = lf(dir, 'check');
  return [...checked.out.matchAll(/\b(MOV_[A-Z_]+)\b/g)].map((m) => m[1]!);
}

test('dealroom: a round walked or listened to by its company terms checks clean; a comparison Dealroom cannot take is refused', async () => {
  const { dir, file } = await connected('dealroom');
  const fn = 'function triage(r: <source-[:`Funding Rounds`]->>) {\n  return r.Round\n}';
  // Dealroom takes a term, or any of several.
  assert.deepEqual(codes(dir, file, 'dealroom', `${fn}\nlisten to source-[r:\`Funding Rounds\` WHERE r.\`Company Locations\` CONTAINS "Europe" OR r.\`Company Locations\` CONTAINS "US"]-> fire triage`), []);
  assert.deepEqual(codes(dir, file, 'dealroom', `function rounds() {\n  return source-[r:\`Funding Rounds\` WHERE r.\`Company Industries\` CONTAINS "fintech"]->\n}`), []);
  // An OR across fields is judged on the host, which cannot judge a term.
  assert.deepEqual(codes(dir, file, 'dealroom', `${fn}\nlisten to source-[r:\`Funding Rounds\` WHERE r.\`Company Locations\` CONTAINS "Europe" OR r.Amount > 5000000]-> fire triage`), ['MOV_FILTER_NOT_TAKEN']);
  // A company's own rounds are listed whole: nothing reaches Dealroom's search.
  assert.deepEqual(
    codes(dir, file, 'dealroom', `function rounds() {\n  c = only(source-[c:Companies WHERE c.Name == "Acme"]->)\n  if (c != null) {\n    return c-[r:\`Funding Rounds\` WHERE r.\`Company Locations\` CONTAINS "Europe"]->\n  }\n  return []\n}`),
    ['MOV_FILTER_NOT_TAKEN'],
  );
});

test('evertrace: signals walked or listened to by a saved search check clean; anything else on it, or on a list name, is refused', async () => {
  const { dir, file } = await connected('evertrace');
  const fn = 'function triage(s: <source-[:Signals]->>) {\n  return s.Name\n}';
  assert.deepEqual(codes(dir, file, 'evertrace', `${fn}\nlisten to source-[s:Signals WHERE s.\`Saved Search\` == "Stealth in Europe" AND s.Score >= 80]-> fire triage`), []);
  assert.deepEqual(codes(dir, file, 'evertrace', `function signals() {\n  return source-[s:Signals WHERE s.\`Saved Search\` == "Stealth in Europe"]->\n}`), []);
  for (const where of ['s.`Saved Search` == "A" OR s.Name == "b"', 's.`Saved Search` != "A"']) {
    assert.deepEqual(codes(dir, file, 'evertrace', `${fn}\nlisten to source-[s:Signals WHERE ${where}]-> fire triage`), ['MOV_FILTER_NOT_TAKEN'], where);
  }
  // A list's entries are listed whole: only a listen on List Entries takes a list name.
  const entries = 'function entered(e: <source-[:`List Entries`]->>) {\n  return e.`Added At`\n}';
  assert.deepEqual(codes(dir, file, 'evertrace', `${entries}\nlisten to source-[e:\`List Entries\` WHERE e.\`List Name\` IN ["Pipeline", "Later"]]-> fire entered`), []);
  assert.deepEqual(
    codes(dir, file, 'evertrace', `function entries() {\n  l = only(source-[l:Lists WHERE l.Name == "Pipeline"]->)\n  if (l != null) {\n    return l-[e:Entries WHERE e.\`List Name\` == "Pipeline"]->\n  }\n  return []\n}`),
    ['MOV_FILTER_NOT_TAKEN'],
  );
});
