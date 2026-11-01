import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { EntityStore } from '../../store';
import { airtableRoutes } from '../airtable';

async function bootApp(seed: (store: EntityStore) => void = () => {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const store = new EntityStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'airtable-test-')), 'fake-channels.db'));
  seed(store);
  const app = express();
  app.use(express.json());
  app.use('/', airtableRoutes(store));
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Register a webhook on `baseId` told of `dataType`, as the module does. */
const register = (baseUrl: string, baseId: string, dataType: 'tableData' | 'tableMetadata') =>
  post(`${baseUrl}/v0/bases/${baseId}/webhooks`, {
    notificationUrl: `https://lf.test/${baseId}/${dataType}`,
    specification: { options: { filters: { dataTypes: [dataType], changeTypes: ['add', 'update', 'remove'] } } },
  });

test('one OAuth integration makes at most 2 webhooks on a base: a third is refused, another base is not, and a removed one makes room', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    assert.equal((await register(baseUrl, 'appA', 'tableMetadata')).status, 200, 'the schema webhook');
    const data = (await (await register(baseUrl, 'appA', 'tableData')).json()) as { id: string };
    const third = await register(baseUrl, 'appA', 'tableData');
    assert.equal(third.status, 422);
    assert.equal(((await third.json()) as { error: { type: string } }).error.type, 'TOO_MANY_WEBHOOKS_BY_OAUTH_INTEGRATION_IN_BASE');
    assert.equal((await register(baseUrl, 'appB', 'tableData')).status, 200, 'the cap is per base');

    assert.equal((await fetch(`${baseUrl}/v0/bases/appA/webhooks/${data.id}`, { method: 'DELETE' })).status, 200);
    assert.equal((await register(baseUrl, 'appA', 'tableData')).status, 200, 'room again');
  } finally {
    await close();
  }
});

test('a lapsed webhook is not counted against the cap', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    assert.equal((await register(baseUrl, 'appA', 'tableMetadata')).status, 200);
    assert.equal((await register(baseUrl, 'appA', 'tableData')).status, 200);
    assert.equal((await post(`${baseUrl}/control/advance-clock`, { ms: 8 * 24 * 60 * 60 * 1000 })).status, 200);
    assert.equal((await register(baseUrl, 'appA', 'tableData')).status, 200);
  } finally {
    await close();
  }
});

test('a record search by formula answers the records it holds for: fields by name or by id, AND and OR of equalities, quotes escaped', async () => {
  const { baseUrl, close } = await bootApp((store) => {
    store.create('airtable', 'base', { id: 'appO', name: 'Office' }, 'appO');
    store.create('airtable', 'table:appO', { id: 'tblL', name: 'Lunch', primaryFieldId: 'fldPoll', fields: [{ id: 'fldPoll', name: 'Poll' }, { id: 'fldPerson', name: 'Person' }] }, 'tblL');
  });
  try {
    const ada = (await (await post(`${baseUrl}/v0/appO/tblL`, { fields: { fldPoll: 'p1', fldPerson: 'ada' } })).json()) as { id: string };
    await post(`${baseUrl}/v0/appO/tblL`, { fields: { Poll: 'p1', Person: 'pri "ya"' } });
    const search = async (formula: string) => {
      const answer = (await (await fetch(`${baseUrl}/v0/appO/tblL?${new URLSearchParams({ filterByFormula: formula })}`)).json()) as { records: Array<{ id: string }> };
      return answer.records.length;
    };
    assert.equal(await search('AND({Poll} = "p1",{Person} = "ada")'), 1);
    assert.equal(await search('{Person} = "pri \\"ya\\""'), 1);
    assert.equal(await search('OR({Person} = "ada",{Person} = "bob")'), 1);
    assert.equal(await search('{Poll} = "p2"'), 0);
    assert.equal(await search(`RECORD_ID() = "${ada.id}"`), 1);
    // A formula it does not read answers every record, as before.
    assert.equal(await search('SEARCH("a", {Person})'), 2);
  } finally {
    await close();
  }
});
