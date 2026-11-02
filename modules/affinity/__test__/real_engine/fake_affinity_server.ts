// The deal sync's fake Affinity on a real port, so `listen-fire run` can drive the
// module through the real engine and its requests can be counted.
//
//   node --require tsx/cjs fake_affinity_server.ts <plan.json> <requests.log>
//
// `plan.json` seeds the workspace: { owners: [email…], deals: [{ name, host,
// founders: [{ first, last, linkedin }], seed: "synced" | "empty-field" | "new",
// portfolio?: { dealCreated, ownership } }], portfolio?: true }: with `portfolio`
// the workspace has a second list, and a deal naming one sits on it too. With
// `twinPersons` each organization has a person of the same id, as Affinity's
// separately numbered records can. With `opportunityList` the workspace has an
// opportunity list, `Deals`, holding an opportunity for each seeded company.
// Every request is appended to `requests.log`, one `METHOD /path?query` a line.
// It prints `listening on <port>` once it is up.

import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { FakeAffinity, seedDealsEntry, seedPortfolioEntry, seedSyncedDeal, seedWorkspace } from '../deal_sync_fixture';

interface PlanFounder {
  first: string;
  last: string;
  linkedin: string;
}
interface Plan {
  owners: string[];
  deals: Array<{
    name: string;
    host: string;
    founders: PlanFounder[];
    seed: 'synced' | 'empty-field' | 'new';
    portfolio?: { dealCreated: string; ownership: string };
  }>;
  portfolio?: boolean;
  twinPersons?: boolean;
  /** An opportunity list, `Deals`, with each seeded company's opportunity on it. */
  opportunityList?: boolean;
}

const [planFile, logFile] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planFile, 'utf8')) as Plan;

const fake = new FakeAffinity({ portfolio: plan.portfolio, opportunityList: plan.opportunityList });
const { owners } = seedWorkspace(fake, plan.owners);
for (const deal of plan.deals) {
  if (deal.seed === 'new') continue;
  const seeded = seedSyncedDeal(fake, owners, { ...deal, founder: deal.founders[0] }, { emptyDealSource: deal.seed === 'empty-field' });
  if (deal.portfolio) seedPortfolioEntry(fake, seeded, deal.portfolio);
  if (plan.opportunityList) seedDealsEntry(fake, { name: `${deal.name} — Seed`, orgId: seeded.org.id, stage: 'Sourced' });
}
if (plan.twinPersons) {
  for (const org of [...fake.orgs.values()]) {
    fake.persons.set(org.id, { id: org.id, first_name: 'Twin', last_name: org.name, primary_email: null, emails: [], organization_ids: [] });
  }
}
fake.install();
const answer = global.fetch;

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer) => (body += chunk.toString()));
  req.on('end', () => {
    void (async () => {
      // The movement's change log goes to Slack; this answers it as an empty
      // workspace with the log channel in it, and none of it is Affinity's.
      if (req.url?.startsWith('/slack/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, channels: [{ id: 'C1', name: 'auto-affinity-log', is_member: true }], ts: '1.0', channel: 'C1', response_metadata: {} }));
        return;
      }
      const url = `http://fake.affinity${req.url ?? '/'}`;
      const before = fake.requests.length;
      const response = await answer(url, { method: req.method, ...(body ? { body } : {}) });
      for (const request of fake.requests.slice(before)) appendFileSync(logFile, `${request}\n`);
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(await response.text());
    })();
  });
});
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  process.stdout.write(`listening on ${(server.address() as AddressInfo).port}\n`);
});
