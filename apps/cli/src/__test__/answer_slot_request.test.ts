// `answerSlotRequest`: the slot envelope's rules for one request, without a
// server (a host router applies the same rules `serveSlot` does).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION } from 'engine-contracts';
import { SlotRefusal, answerSlotRequest } from 'movement-engine/public/module-wire';

const manifest = { name: 'acme', slot: 'models', protocolVersion: 2, methods: ['models.call'] } as unknown as Parameters<typeof answerSlotRequest>[0];
const request = (method: string, extra: object = {}) => ({ protocolVersion: PROTOCOL_VERSION, method, params: {}, ...extra });

test('the manifest method answers the manifest without asking the module', async () => {
  const answered = await answerSlotRequest(manifest, async () => assert.fail('asked'), request('manifest'));
  assert.deepEqual(answered, { status: 200, body: { ok: true, result: manifest } });
});

test('a method is answered with its params and settings, and no result is null', async () => {
  const seen: unknown[] = [];
  const answer = async (method: string, params: object, settings: object) => (seen.push([method, params, settings]), method === 'a.b' ? { x: 1 } : undefined);
  assert.deepEqual(await answerSlotRequest(manifest, answer, request('a.b', { params: { p: 1 }, settings: { s: 'v' } })), { status: 200, body: { ok: true, result: { x: 1 } } });
  assert.deepEqual(seen, [['a.b', { p: 1 }, { s: 'v' }]]);
  assert.deepEqual(await answerSlotRequest(manifest, answer, request('a.none')), { status: 200, body: { ok: true, result: null } });
  assert.deepEqual(seen[1], ['a.none', {}, {}], 'absent settings are an empty object');
});

test('another protocol version is refused by name, not as a bad request', async () => {
  const answered = await answerSlotRequest(manifest, async () => null, { ...request('manifest'), protocolVersion: '1' });
  assert.equal(answered.status, 200);
  assert.deepEqual(answered.body, { ok: false, error: { code: 'protocol_version', message: `this module speaks protocol ${PROTOCOL_VERSION}`, retryable: false } });
});

test('a body that is not the envelope is a bad request', async () => {
  for (const body of [null, 'x', 7, [], {}, { protocolVersion: PROTOCOL_VERSION }, { protocolVersion: PROTOCOL_VERSION, method: '' }]) {
    assert.deepEqual(await answerSlotRequest(manifest, async () => null, body), { status: 400, body: { error: 'bad_request' } }, JSON.stringify(body));
  }
});

test('a SlotRefusal keeps its code and data and is not retryable-by-default', async () => {
  const answer = async () => {
    throw new SlotRefusal('unknown_method', 'no such method', { method: 'x' });
  };
  assert.deepEqual(await answerSlotRequest(manifest, answer, request('x')), {
    status: 200,
    body: { ok: false, error: { code: 'unknown_method', message: 'no such method', retryable: false, data: { method: 'x' } } },
  });
});

test('any other throw is a retryable module_error carrying its message', async () => {
  const thrown = async () => {
    throw new Error('boom');
  };
  assert.deepEqual(await answerSlotRequest(manifest, thrown, request('x')), { status: 200, body: { ok: false, error: { code: 'module_error', message: 'boom', retryable: true } } });
  const text = async () => {
    throw 'plain';
  };
  const answered = await answerSlotRequest(manifest, text, request('x'));
  assert.deepEqual(answered.body, { ok: false, error: { code: 'module_error', message: 'plain', retryable: true } });
});
