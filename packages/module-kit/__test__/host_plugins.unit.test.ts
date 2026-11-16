// A module's `ctx.host.invalidatePluginAnswers`: through the host's plugins
// door (adapter protocol 2.10); a host before it, which keeps no answers,
// has none to forget.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { hostPluginAnswers, keepingNoAnswers, moduleContext, noCredential } from '../index';

interface Door {
  url: string;
  received: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

async function door(status: number, answer: unknown): Promise<Door> {
  const received: Door['received'] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/api/public/adapter/team/plugins`, received, close: () => new Promise((done) => server.close(() => done())) };
}

describe('ctx.host through the plugins door', () => {
  it('says one answer, or every answer, of a plugin changed, with the door token', async () => {
    const served = await door(200, { result: null });
    try {
      const host = hostPluginAnswers({ url: served.url, headers: { authorization: 'Bearer host-token' } });
      await host.invalidatePluginAnswers({ plugin: 'is-member', args: ['ann@acme.com'] });
      await host.invalidatePluginAnswers({ plugin: 'is-member' });
      expect(served.received.map(({ body }) => body)).toEqual([
        { method: 'plugins.invalidate', params: { plugin: 'is-member', args: ['ann@acme.com'] } },
        { method: 'plugins.invalidate', params: { plugin: 'is-member' } },
      ]);
      expect(served.received[0].headers.authorization).toBe('Bearer host-token');
    } finally {
      await served.close();
    }
  });

  it('reads an older host, which serves no plugins door, as having nothing to forget', async () => {
    const served = await door(404, { error: 'not found' });
    try {
      await expect(hostPluginAnswers({ url: served.url, headers: {} }).invalidatePluginAnswers({ plugin: 'is-member' })).resolves.toBeUndefined();
    } finally {
      await served.close();
    }
  });

  it("refuses with the door's own message", async () => {
    const served = await door(400, { error: 'bad_request', message: "plugins.invalidate's args are a list, as a call passes them" });
    try {
      await expect(hostPluginAnswers({ url: served.url, headers: {} }).invalidatePluginAnswers({ plugin: 'is-member' })).rejects.toThrow("plugins.invalidate's args are a list");
    } finally {
      await served.close();
    }
  });

  it('is a host that keeps no answers when the host hands none', async () => {
    const ctx = moduleContext({
      tenant: 't',
      credential: noCredential('none'),
      log: { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined },
      files: { put: async () => Promise.reject(new Error('no')), read: async () => Promise.reject(new Error('no')), expose: async () => Promise.reject(new Error('no')) },
      kv: { get: async () => undefined, set: async () => undefined, delete: async () => undefined, list: async () => [], compareAndSet: async () => false },
      validateResults: false,
    });
    expect(ctx.host).toBe(keepingNoAnswers);
    await expect(ctx.host.invalidatePluginAnswers({ plugin: 'is-member' })).resolves.toBeUndefined();
  });
});
