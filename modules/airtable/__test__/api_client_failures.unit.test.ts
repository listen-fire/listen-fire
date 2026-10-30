// How the Airtable client fails, against a local stub of Airtable's API: a
// refused token fails at once as a credential refusal, naming what Airtable
// said; any other status no retry can change fails at once; a transient
// failure (5xx, 429) is sent again, within a bounded number of attempts and a
// total waiting budget, and then fails by name.

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { CredentialRefusedError } from 'module-kit';

import { AirtableAPIClient, AirtableRequestError } from '../api_client';

type Answer = { status: number; body: string };

async function stub(answers: (n: number) => Answer): Promise<{ baseUrl: string; requests: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server: Server = createServer((_req, res) => {
    requests += 1;
    const answer = answers(requests);
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(answer.body);
  });
  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests: () => requests,
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}

const REFUSED: Answer = { status: 401, body: '{"error":{"type":"AUTHENTICATION_REQUIRED","message":"Authentication required"}}' };
const BASES: Answer = { status: 200, body: '{"bases":[{"id":"app1","name":"Finance"}]}' };

/** A client whose waits are recorded rather than slept. */
function clientAt(baseUrl: string, tokens: { accessToken: () => Promise<string>; refresh: () => Promise<void> }) {
  const waits: number[] = [];
  const client = new AirtableAPIClient({
    baseUrl,
    tokens,
    retry: { sleep: async (ms) => void waits.push(ms), random: () => 1 },
  });
  return { client, waits };
}

const unrefreshable = {
  accessToken: async () => 'fake',
  refresh: async () => {
    throw new Error('this host refreshes only before a call');
  },
};

describe('the Airtable client against a refusing or failing Airtable', () => {
  it('a refused token fails at once as a credential refusal, saying what Airtable said', async () => {
    const airtable = await stub(() => REFUSED);
    try {
      const { client, waits } = clientAt(airtable.baseUrl, unrefreshable);
      const error = await client.listBases().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CredentialRefusedError);
      expect((error as Error).message).toMatch(/^Airtable refused the access token \(HTTP 401\) to GET \/v0\/meta\/bases: .*Authentication required/);
      expect(airtable.requests()).toBe(1);
      expect(waits).toEqual([]);
    } finally {
      await airtable.close();
    }
  });

  it('a refused token a refresh replaced is sent once more', async () => {
    const airtable = await stub((n) => (n === 1 ? REFUSED : BASES));
    let token = 'old';
    try {
      const { client } = clientAt(airtable.baseUrl, { accessToken: async () => token, refresh: async () => void (token = 'new') });
      expect(await client.listBases()).toEqual([{ id: 'app1', name: 'Finance' }]);
      expect(airtable.requests()).toBe(2);
    } finally {
      await airtable.close();
    }
  });

  it('a status no retry can change (403) fails at once, naming the status and what Airtable said', async () => {
    const airtable = await stub(() => ({ status: 403, body: '{"error":"INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND"}' }));
    try {
      const { client, waits } = clientAt(airtable.baseUrl, unrefreshable);
      const error = await client.listBases().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AirtableRequestError);
      expect((error as AirtableRequestError).status).toBe(403);
      expect((error as Error).message).toMatch(/HTTP 403 .*GET \/v0\/meta\/bases: .*INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND/);
      expect(airtable.requests()).toBe(1);
      expect(waits).toEqual([]);
    } finally {
      await airtable.close();
    }
  });

  it('a transient failure is sent again, and recovers', async () => {
    const airtable = await stub((n) => (n < 3 ? { status: 503, body: '{}' } : BASES));
    try {
      const { client, waits } = clientAt(airtable.baseUrl, unrefreshable);
      expect(await client.listBases()).toEqual([{ id: 'app1', name: 'Finance' }]);
      expect(airtable.requests()).toBe(3);
      expect(waits).toEqual([1000, 2000]);
    } finally {
      await airtable.close();
    }
  });

  it('a failure that stays transient stops after a bounded number of attempts and waits, and fails by name', async () => {
    const airtable = await stub(() => ({ status: 503, body: '{"error":"SERVICE_UNAVAILABLE"}' }));
    try {
      const { client, waits } = clientAt(airtable.baseUrl, unrefreshable);
      const error = await client.listBases().catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/^Airtable GET \/v0\/meta\/bases failed: HTTP 503 after 5 attempts \(waited 15\.0s\): .*SERVICE_UNAVAILABLE/);
      expect(airtable.requests()).toBe(5);
      expect(waits).toEqual([1000, 2000, 4000, 8000]);
    } finally {
      await airtable.close();
    }
  });

  it('a 429 waits Airtable\'s 30 s penalty, and a second one past the budget fails by name', async () => {
    const airtable = await stub(() => ({ status: 429, body: '{"errors":[{"error":"RATE_LIMIT_REACHED"}]}' }));
    try {
      const { client, waits } = clientAt(airtable.baseUrl, unrefreshable);
      const error = await client.listBases().catch((e: unknown) => e);
      expect((error as Error).message).toMatch(/^Airtable GET \/v0\/meta\/bases failed: HTTP 429 after 2 attempts \(waited 30\.0s\)/);
      expect(waits).toEqual([30_000]);
    } finally {
      await airtable.close();
    }
  });
});
