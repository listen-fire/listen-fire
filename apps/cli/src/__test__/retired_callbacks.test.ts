// Callbacks retired at 0.13 (a run waits on a form from the @lf/forms
// adapter, or on a message's Interactions), and the host machinery went with
// them: `listen-fire call` names its replacement and stops, and a link minted
// by an earlier release answers that it is gone for good.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lf, project, served } from './example';

test('listen-fire call is retired by name', () => {
  const dir = project();
  const called = lf(dir, 'call', 'cb_minted-by-0-12', '--body', 'values.json');
  assert.equal(called.code, 2, called.out);
  assert.equal(
    called.out.trim(),
    'listen-fire call is retired in 0.13: a run waits on a form from the @lf/forms adapter, answered by opening or posting to its Url',
  );
});

test('/api/cb answers 410 retired', async () => {
  const dir = project();
  const serving = await served(dir);
  try {
    for (const method of ['GET', 'POST']) {
      const response = await fetch(`http://127.0.0.1:${serving.port}/api/cb/cb_minted-by-0-12`, {
        method,
        ...(method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: '{"note":"late"}' } : {}),
      });
      assert.equal(response.status, 410, method);
      assert.deepEqual(await response.json(), {
        outcome: 'retired',
        message: 'callbacks are retired in listen-fire 0.13; this link belonged to a run on an earlier release',
      });
    }
  } finally {
    await serving.stop();
  }
});
