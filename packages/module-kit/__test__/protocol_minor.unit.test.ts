// A module's manifest states the minor of adapter protocol 2 it needs its host
// to speak: the definition's own `protocolMinor`, else 0. The methods it
// offers never raise it, so an older host still reads it.

import { Readable } from 'node:stream';

import { PROTOCOL_VERSION } from 'engine-contracts';
import type { PluginDeclaration } from 'engine-contracts';

import type { IncomingMessage, ServerResponse } from 'node:http';

import { defineModule, type PluginModuleDefinition } from '../define';
import { refusingFiles, refusingKv } from '../in_process';
import { createModuleProtocolHandler } from '../module_server';
import { adapterManifestResult } from '../server';

const ECHO: PluginDeclaration = {
  priced: false,
  signature: {
    name: 'echo',
    description: 'Say hello.',
    params: [],
    dataDependency: 'none',
    additions: {},
    effects: {},
    output: { kind: 'value', type: { kind: 'string' } },
  },
};

function echo(protocolMinor?: number): PluginModuleDefinition {
  const definition: PluginModuleDefinition = {
    kind: 'plugin',
    name: '@lf/echo',
    credentials: [],
    plugins: [ECHO],
    ...(protocolMinor !== undefined ? { protocolMinor } : {}),
    create: () => ({ invokePlugin: async () => ({ text: 'hello' }) }),
  };
  return defineModule(definition);
}

async function manifestOf(definition: PluginModuleDefinition): Promise<Record<string, unknown>> {
  const handler = createModuleProtocolHandler({
    definition,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
    files: refusingFiles('no files'),
    kvFor: () => refusingKv('no kv'),
  });
  const req = Object.assign(Readable.from([JSON.stringify({ protocolVersion: PROTOCOL_VERSION, cacheScopeId: 's', method: 'manifest', params: {} })]), {
    headers: {},
  }) as unknown as IncomingMessage;
  let payload = '';
  const res = { writeHead: () => undefined, end: (body: string) => void (payload = body) } as unknown as ServerResponse;
  await handler(req, res);
  const body = JSON.parse(payload);
  expect(body.ok).toBe(true);
  return body.result;
}

test('a module using no later feature states 2.0', async () => {
  expect(await manifestOf(echo())).toMatchObject({ protocolVersion: 2, protocolMinor: 0 });
});

test("the definition's protocolMinor is the stated minor", async () => {
  expect(await manifestOf(echo(1))).toMatchObject({ protocolMinor: 1 });
  expect(await manifestOf(echo(3))).toMatchObject({ protocolMinor: 3 });
});

test('an adapter served from its instance states the minor its methods use', () => {
  const adapter = {
    adapterType: 'acme',
    supportedTriggers: [],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    webhookEventTypeId: undefined,
  };
  expect(adapterManifestResult(adapter as never, ['manifest', 'describe'])).toMatchObject({ protocolVersion: 2, protocolMinor: 0 });
});

test('an adapter offering a newer method (refreshEventSubscription, 2.4) still states 2.0', () => {
  const adapter = {
    adapterType: 'acme',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
    webhookEventTypeId: undefined,
  };
  expect(adapterManifestResult(adapter as never, ['manifest', 'ensureEventSubscription', 'refreshEventSubscription'])).toMatchObject({ protocolMinor: 0 });
});
