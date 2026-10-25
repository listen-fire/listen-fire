// The WASM artifact's environment services (the loader's import) answer as
// the committed fixture says: the fixture the native implementation is held
// to (crates/movement-engine/tests/env_services.rs), so the two agree. A
// Node whose ICU or zone data moved fails here first; regenerate the
// fixture (crates/movement-engine/tests/env/generate.ts) and move the
// crate's jiff-tzdb pin with it.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { answerEnvRequest } from '../env_services';

const fixture: Array<{ request: { op?: string }; answer: unknown }> = JSON.parse(
  readFileSync(path.join(__dirname, '../../../../crates/movement-engine/tests/env/fixture.json'), 'utf8'),
);
const recordedWith: { tz: string; node: string } = JSON.parse(
  readFileSync(path.join(__dirname, '../../../../crates/movement-engine/tests/env/versions.json'), 'utf8'),
);

// tz versions are a year and a letter ("2026e"), so a text compare orders them.
const runningTz = process.versions.tz;
const tzOlderThanFixture = runningTz !== undefined && runningTz < recordedWith.tz;

const differing = (cases: typeof fixture) =>
  cases.filter(({ request, answer }) => JSON.stringify(answerEnvRequest(request).value) !== JSON.stringify(answer)).map((c) => c.request);

// A zone's rules move between tzdata releases, so a Node whose tz data is older
// than the fixture's answers some zones differently through no fault of the
// code: those cases are skipped, by name, rather than failed.
const tzIt = tzOlderThanFixture ? it.skip : it;

describe('the environment services', () => {
  it('answer every fixture request but the zone conversions as recorded', () => {
    expect(fixture.length).toBeGreaterThan(5000);
    expect(differing(fixture.filter(({ request }) => request.op !== 'tz_convert'))).toEqual([]);
  });

  tzIt(
    tzOlderThanFixture
      ? `answer every zone conversion as recorded (SKIPPED: this Node's tz data is ${runningTz}, older than the fixture's ${recordedWith.tz} recorded under ${recordedWith.node}; run under that Node or newer)`
      : 'answer every zone conversion as recorded',
    () => {
      expect(differing(fixture.filter(({ request }) => request.op === 'tz_convert'))).toEqual([]);
    },
  );

  it('refuse a request they cannot read', () => {
    expect(() => answerEnvRequest({ op: 'nope' })).toThrow('no environment service nope');
    expect(() => answerEnvRequest({ op: 'normalize', text: 'x', form: 'NFX' })).toThrow('no normalisation form NFX');
  });
});
