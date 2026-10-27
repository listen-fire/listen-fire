// What differs per tenant: the schema a customer's CRM describes (its own
// fields, a select with its own options), checked when its movement is saved;
// and a ready-made module (Slack) loaded for the customer with its own
// credential, writing into that customer's workspace only.

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import { adapterInProcess, memoryKv, noCredential, refusingFiles } from '@listen-fire/module-kit';

import { Embedding } from '../src/embedding';
import { COMPANY, CompanyStore, companyCreated, crmModule } from '../src/crm';
import { fakeModels } from '../src/models';

const PRELUDE = `import { crm } from adapters
import { workspace } from credentials

app = connect crm using workspace
`;

/** A movement that files every new company under `stage`. */
const stageAs = (stage: string) => `${PRELUDE}
function file_under(company: <app-[:Company]->>) {
  write app-[:Company]-> { Name: "\${company.Name}", Stage: "${stage}" }
}

listen to app { events: ["company.created"] } fire file_under
`;

const ACME_FIELDS = [{ name: 'Stage', options: ['Lead', 'Customer'] }, { name: 'Note' }];
const GLOBEX_FIELDS = [{ name: 'Stage', options: ['Prospect', 'Partner'] }, { name: 'Region' }];

function embedding(): Embedding {
  const e = new Embedding({ models: fakeModels() });
  e.addCustomer('acme', 'acme-key', ACME_FIELDS);
  e.addCustomer('globex', 'globex-key', GLOBEX_FIELDS);
  return e;
}

test('each tenant describes its own fields, a select with its own options', async () => {
  const store = new CompanyStore();
  store.defineFields('acme', ACME_FIELDS);
  store.defineFields('globex', GLOBEX_FIELDS);
  const describe = async (tenant: string) => {
    const { adapter } = adapterInProcess(crmModule(store), {
      tenant,
      credential: noCredential('describing needs none'),
      log: { debug() {}, info() {}, warn() {}, error() {} },
      files: refusingFiles('no files'),
      kv: memoryKv(),
      validateResults: true,
    });
    return (await adapter.describe(COMPANY))?.fields.map(({ fieldId, kind, enumValues }) => ({ fieldId, kind, ...(enumValues !== undefined ? { enumValues } : {}) }));
  };
  assert.deepEqual(await describe('acme'), [
    { fieldId: 'Name', kind: 'string' },
    { fieldId: 'Stage', kind: 'enum', enumValues: ['Lead', 'Customer'] },
    { fieldId: 'Note', kind: 'string' },
  ]);
  assert.deepEqual(await describe('globex'), [
    { fieldId: 'Name', kind: 'string' },
    { fieldId: 'Stage', kind: 'enum', enumValues: ['Prospect', 'Partner'] },
    { fieldId: 'Region', kind: 'string' },
  ]);
});

test("an option valid for one tenant is refused for the other, on save; each tenant's own passes", async () => {
  const saas = embedding();
  assert.deepEqual(await saas.save('acme', 'file', stageAs('Lead')), { saved: true, listens: 1 });
  assert.deepEqual(await saas.save('globex', 'file', stageAs('Partner')), { saved: true, listens: 1 });

  const wrongForGlobex = await saas.save('globex', 'lead', stageAs('Lead'));
  assert.equal(wrongForGlobex.saved, false);
  assert.match(wrongForGlobex.saved ? '' : wrongForGlobex.problems.join('\n'), /MOV_ENUM_UNKNOWN_VALUE/);
  const wrongForAcme = await saas.save('acme', 'partner', stageAs('Partner'));
  assert.equal(wrongForAcme.saved, false);
  assert.match(wrongForAcme.saved ? '' : wrongForAcme.problems.join('\n'), /MOV_ENUM_UNKNOWN_VALUE/);

  // A field only the other tenant defines is not there either.
  const noRegion = await saas.save('acme', 'region', stageAs('Lead').replace('Stage: "Lead"', 'Region: "EU"'));
  assert.equal(noRegion.saved, false);
});

interface FakeChannels {
  url: string;
  stop(): Promise<void>;
}

/** One workspace's worth of Slack: `@listen-fire/fake-channels` on a free port. */
async function fakeChannels(): Promise<FakeChannels> {
  const child: ChildProcess = spawn(process.execPath, [require.resolve('@listen-fire/fake-channels/bin/fake-channels.cjs')], {
    cwd: mkdtempSync(join(tmpdir(), 'embed-saas-fake-')),
    env: { ...process.env, FAKE_CHANNELS_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  const url = await new Promise<string>((found, failed) => {
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const port = /running on http:\/\/localhost:(\d+)/.exec(line)?.[1];
      if (port !== undefined) found(`http://127.0.0.1:${port}`);
    });
    void exited.then(() => failed(new Error('fake-channels exited before listening')));
  });
  return { url, stop: async () => (child.kill('SIGTERM'), exited) };
}

async function messagesIn(fake: FakeChannels): Promise<string[]> {
  const rows: Array<{ text?: string }> = await (await fetch(`${fake.url}/admin/slack/message/state`)).json();
  return rows.flatMap(({ text }) => (text === undefined ? [] : [text]));
}

const ANNOUNCE = `${PRELUDE}
import { slack } from adapters
import { slack_workspace } from credentials

team = connect slack using slack_workspace

function announce(company: <app-[:Company]->>) {
  general = only(team-[ch:Channels WHERE ch.Name == "general"]->)
  if (general == null) { fail("no #general channel") }
  write general-[:Messages]-> { Message: "New company: \${company.Name}" }
}

listen to app { events: ["company.created"] } fire announce
`;

let acmeSlack: FakeChannels;
let globexSlack: FakeChannels;

before(async () => {
  [acmeSlack, globexSlack] = await Promise.all([fakeChannels(), fakeChannels()]);
});

after(async () => {
  await Promise.all([acmeSlack.stop(), globexSlack.stop()]);
});

test("a post through the ready-made Slack module lands in that tenant's workspace only", async () => {
  const saas = embedding();
  // Each customer's own bot token, and its own workspace (the fake's base URL).
  saas.connectSlack('acme', { accessToken: 'xoxb-acme', baseUrl: `${acmeSlack.url}/slack/` });
  saas.connectSlack('globex', { accessToken: 'xoxb-globex', baseUrl: `${globexSlack.url}/slack/` });
  assert.deepEqual(await saas.save('acme', 'announce', ANNOUNCE), { saved: true, listens: 1 });

  const before = await messagesIn(globexSlack);
  const company = saas.companies.add('acme', { Name: 'Vireo' });
  assert.deepEqual(await saas.fire('acme', companyCreated(company)), [{ movement: 'announce', outcome: { ok: true, writes: 1, spentMicrodollars: 0 } }]);

  assert.ok((await messagesIn(acmeSlack)).includes('New company: Vireo'));
  assert.deepEqual(await messagesIn(globexSlack), before);
});

test('a customer that has not connected Slack cannot save a movement that imports it', async () => {
  const saas = embedding();
  const refused = await saas.save('globex', 'announce', ANNOUNCE);
  assert.equal(refused.saved, false);
  assert.match(refused.saved ? '' : refused.problems.join('\n'), /MOV_IMPORT_UNKNOWN.*'slack'/);
});
