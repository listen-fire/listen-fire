// A served module's run scope: the calls a host makes under one scope id share
// one run's memo, as they would in process; calls under another id, or under
// an id that names no run, do not; and a scope no call has touched for a
// while, or one past the most a process keeps, is let go.

import { Readable } from 'node:stream';

import { PROTOCOL_VERSION, type PluginDeclaration } from 'engine-contracts';
import { memoisedRead } from 'module-runtime/run_scope';

import type { IncomingMessage, ServerResponse } from 'node:http';

import { defineModule } from '../define';
import { refusingFiles, refusingKv } from '../in_process';
import { createModuleProtocolHandler } from '../module_server';
import { runScopes, type RunScopes } from '../run_scopes';

const READ_ONCE: PluginDeclaration = {
  priced: false,
  signature: {
    name: 'read_once',
    description: 'A memoised read of one record.',
    params: [],
    dataDependency: 'none',
    additions: {},
    effects: {},
    output: { kind: 'value', type: { kind: 'string' } },
  },
};

function harness(scopes: RunScopes) {
  let loads = 0;
  const handler = createModuleProtocolHandler({
    definition: defineModule({
      kind: 'plugin',
      name: '@lf/memoising',
      credentials: [],
      plugins: [READ_ONCE],
      create: () => ({
        invokePlugin: async () => ({ text: await memoisedRead('record 1', async () => `load ${++loads}`) }),
      }),
    }),
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    files: refusingFiles('no files'),
    kvFor: () => refusingKv('no kv'),
    runScopes: scopes,
  });
  const call = async (cacheScopeId: string): Promise<unknown> => {
    const envelope = { protocolVersion: PROTOCOL_VERSION, cacheScopeId, method: 'invokePlugin', params: { name: 'read_once', config: {}, extractedContext: {} } };
    const req = Object.assign(Readable.from([JSON.stringify(envelope)]), { headers: {} }) as unknown as IncomingMessage;
    let payload = '';
    const res = { writeHead: () => undefined, end: (body: string) => void (payload = body) } as unknown as ServerResponse;
    await handler(req, res);
    return JSON.parse(payload).result;
  };
  return { call, loads: () => loads };
}

test('two calls under one scope id share a read; another scope id reads afresh', async () => {
  const { call, loads } = harness(runScopes());
  expect(await call('run-a')).toEqual({ text: 'load 1' });
  expect(await call('run-a')).toEqual({ text: 'load 1' });
  expect(await call('run-b')).toEqual({ text: 'load 2' });
  expect(await call('run-a')).toEqual({ text: 'load 1' });
  expect(loads()).toBe(2);
});

test('an id that names no run (a call outside any run) opens no scope', async () => {
  const scopes = runScopes();
  const { call, loads } = harness(scopes);
  await call('<none>');
  await call('<none>');
  await call('<slot>');
  expect(loads()).toBe(3);
  expect(scopes.open()).toBe(0);
});

test('a scope no call has touched for the idle time is released', async () => {
  let now = 0;
  const scopes = runScopes({ idleMs: 1000, most: 10, now: () => now });
  const { call, loads } = harness(scopes);
  await call('run-a');
  now = 999;
  await call('run-a');
  expect(loads()).toBe(1);
  now = 1999;
  await call('run-b');
  expect(scopes.open()).toBe(1);
  await call('run-a');
  expect(loads()).toBe(3);
});

test('past the most scopes a process keeps, the least recently used is released', async () => {
  const scopes = runScopes({ idleMs: 60_000, most: 2 });
  const { call, loads } = harness(scopes);
  await call('run-a');
  await call('run-b');
  await call('run-a');
  await call('run-c');
  expect(scopes.open()).toBe(2);
  await call('run-a');
  expect(loads()).toBe(3);
  await call('run-b');
  expect(loads()).toBe(4);
});

test('a scope with a call in flight is not released for being idle', async () => {
  let now = 0;
  const scopes = runScopes({ idleMs: 1000, most: 10, now: () => now });
  let finish: () => void = () => undefined;
  const held = scopes.around('run-a', () => new Promise<void>((done) => (finish = done)));
  now = 5000;
  await scopes.around('run-b', async () => undefined);
  expect(scopes.open()).toBe(2);
  finish();
  await held;
});
