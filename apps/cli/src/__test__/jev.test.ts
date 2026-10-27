// `@lf/jev` in lf, end to end, against the fake Jev (modules/jev/__test__
// /fake_jev.ts): `lf connect @lf/jev` installs the bundled module, a
// credential names the key and the fake's address, `lf check` types both
// plugins (and refuses a wrong argument), `lf run` writes what Jev answered,
// and the run's record carries what each call cost.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { companies, project } from './example';
import { lf, ok } from './interactive';
import { startFakeJev, type FakeJev } from '../../../../modules/jev/__test__/fake_jev';

const TRIAGE = `import { acme_crm } from adapters
import { \`@lf/jev\` as jev } from plugins
import { acme } from credentials

crm = connect acme_crm using acme

function triage(company: <crm-[:Company]->>) {
  robots = jev.score(company.Name, "Is this company about robotics?")
  kind   = jev.classify({ name: company.Name }, ["software", "robotics", "other"], "What does this company make?")
  write crm-[:Company]-> { Name: "\${kind.label} \${kind.confidence} \${robots.probability}" }
}

listen to crm { events: ["company.created"] } fire triage
`;

function lfAsync(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return lf(dir, args).done;
}

/** The example project with the movement in place, `@lf/jev` connected and
 *  a credential naming the fake. */
async function jevProject(fake: FakeJev, movement = TRIAGE): Promise<string> {
  const dir = project();
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(join(dir, 'movements/triage.mvt'), movement);
  const connected = await ok(lf(dir, ['connect', '@lf/jev', '--yes'], { answers: [] }));
  console.log(connected.trim());
  assert.match(readFileSync(join(dir, 'externals/jev/lf-external.yaml'), 'utf8'), /^kind: plugin$/m);
  const added = await ok(lf(dir, ['credential', 'add', '--module', '@lf/jev', 'typesafe'], { answers: ['jev-key', fake.url] }));
  console.log(added.trim());
  return dir;
}

async function checkWith(dir: string, from: string, to: string): Promise<{ code: number; out: string }> {
  assert.ok(TRIAGE.includes(from), from);
  writeFileSync(join(dir, 'movements/triage.mvt'), TRIAGE.replace(from, to));
  return lfAsync(dir, 'check');
}

test('lf check types jev.score and jev.classify: their answers, a missing argument and a record read from a system', async () => {
  const fake = await startFakeJev({ key: 'jev-key' });
  try {
    const dir = await jevProject(fake);
    const check = await lfAsync(dir, 'check');
    assert.equal(check.code, 0, check.out);

    const probabilityAsText = await checkWith(dir, '${robots.probability}"', '${Text.length(robots.probability)}"');
    assert.equal(probabilityAsText.code, 1, probabilityAsText.out);
    assert.match(probabilityAsText.out, /MOV_BUILTIN_ARG_TYPE Text\.length's 'value' takes text or a list, and this is number/);

    const noQuestion = await checkWith(dir, ', "Is this company about robotics?")', ')');
    assert.equal(noQuestion.code, 1, noQuestion.out);
    assert.match(noQuestion.out, /MOV_THROUGH_ARG_MISSING 'jev\.score' is missing the required argument 'question'/);

    const systemRecord = await checkWith(dir, 'jev.classify({ name: company.Name }', 'jev.classify(company');
    assert.equal(systemRecord.code, 1, systemRecord.out);
    assert.match(systemRecord.out, /MOV_CALL_ARG_TYPE 'jev\.classify' takes structured data for 'subject', and 'subject\.Report' is file/);

    const unknownField = await checkWith(dir, '${kind.label}', '${kind.labels}');
    assert.equal(unknownField.code, 1, unknownField.out);
    console.log([probabilityAsText, noQuestion, systemRecord, unknownField].map((c) => c.out.trim()).join('\n'));
    assert.deepEqual(fake.requests, [], 'checking calls nothing');
  } finally {
    await fake.close();
  }
});

// The checker holds a plugin's positional arguments to their declared types
// only where they are records: a scalar of the wrong type (a number for a
// text, a text for a list) is admitted for every plugin, `pdf.render(5)` and
// `fetchUrl(5)` included. A checker change (crates/movement-checker), out of
// this module's reach; this turns green when it lands.
test('lf check refuses a scalar argument of the wrong type', { todo: 'the checker does not type a plugin\'s positional scalar arguments' }, async () => {
  const fake = await startFakeJev({ key: 'jev-key' });
  try {
    const dir = await jevProject(fake);
    const labelsAsText = await checkWith(dir, '["software", "robotics", "other"]', '"robotics"');
    assert.equal(labelsAsText.code, 1, labelsAsText.out);
    const questionAsNumber = await checkWith(dir, '"Is this company about robotics?"', '5');
    assert.equal(questionAsNumber.code, 1, questionAsNumber.out);
  } finally {
    await fake.close();
  }
});

test('lf run asks Jev both questions, writes the answers, and records what each call cost', async () => {
  const fake = await startFakeJev({ key: 'jev-key' });
  try {
    const dir = await jevProject(fake);
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);
    console.log(run.out.trim());
    assert.deepEqual(companies(dir), ['robotics 0.91 0.83']);

    assert.equal(fake.requests.length, 2);
    const [score, classify] = fake.requests;
    assert.equal(score?.authorization, 'Bearer jev-key');
    assert.deepEqual(score?.body.state, 'Vireo Robotics');
    assert.deepEqual(score?.body.questions, { answer: { type: 'noul', instructions: 'Is this company about robotics?' } });
    assert.deepEqual(classify?.body.questions.answer?.criteria, { o0: 'software', o1: 'robotics', o2: 'other' });

    const runs = await lfAsync(dir, 'runs');
    const id = runs.out.trim().split('\n')[0]?.split(' ')[0] ?? '';
    const shown = await lfAsync(dir, 'runs', 'show', id);
    assert.equal(shown.code, 0, shown.out);
    const record = JSON.parse(shown.out) as { run?: { costMicrodollars?: number; trace?: Array<{ plugin?: string }> } };
    // Jev's count of each request's input tokens (the fake's: a token per four
    // bytes) at $0.042 a million, rounded up.
    const expected = fake.requests.map((r) => Math.ceil(Math.ceil(JSON.stringify(r.body).length / 4) * 0.042)).reduce((a, b) => a + b, 0);
    console.log(JSON.stringify({ costMicrodollars: record.run?.costMicrodollars, expected }));
    assert.equal(record.run?.costMicrodollars, expected);
    assert.deepEqual(record.run?.trace?.map((e) => e.plugin), ['@lf/jev/score', '@lf/jev/classify']);
  } finally {
    await fake.close();
  }
});

test('a refused key fails the run, naming the credential', async () => {
  const fake = await startFakeJev({ key: 'another-key' });
  try {
    const dir = await jevProject(fake);
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /Jev refused the API key \(401\): check the apiKey of the @lf\/jev credential/);
    assert.deepEqual(companies(dir), []);
  } finally {
    await fake.close();
  }
});
