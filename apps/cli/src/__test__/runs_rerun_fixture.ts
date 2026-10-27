// What the rerun tests share (runs_rerun.test.ts and the Postgres test
// beside it): the example, its CRM failing a company named `boom …` and
// taking seconds over one named `slow …`, and the movements that fail, write
// then fail, or complete.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { project } from './example';

export interface RerunShown {
  run: {
    status: string;
    attempt: number;
    attempts: Array<{ attempt: number; status: string; startedAt: string; finishedAt: string | null; writes: number | null; error: string | null }>;
    writeRecords: Array<{ adapter: string; recordType: string; recordId: string; action: string; committed: boolean }> | null;
  };
}

/** The example with `movement` its companies.mvt and its CRM able to fail. */
export function rerunProject(movement: string): string {
  const dir = project();
  const server = join(dir, 'externals/acme_crm/server.mjs');
  const text = readFileSync(server, 'utf8');
  const create = 'createRecord: async ({ recordType, fields: written }) => {\n';
  assert.ok(text.includes(create));
  writeFileSync(
    server,
    text.replace(
      create,
      `${create}    if (String(written?.Name).startsWith('boom')) throw new Error('boom: the CRM refused the company');\n` +
        `    if (String(written?.Name).startsWith('slow')) await new Promise((resolve) => setTimeout(resolve, 3000));\n`,
    ),
  );
  writeFileSync(join(dir, 'movements/companies.mvt'), movement);
  return dir;
}

const welcoming = (body: string) => `import { acme_crm } from adapters
import { acme } from credentials

crm = connect acme_crm using acme

function welcome(company: <crm-[:Company]->>) {
${body}
}

listen to crm { events: ["company.created"] } fire welcome
`;

/** Fails at its one write, having written nothing. */
export const BOOM = welcoming('  write crm-[:Company]-> { Name: "boom ${company.Name}" }');
/** Writes a company, then fails. */
export const WRITES_THEN_BOOM = welcoming('  write crm-[:Company]-> { Name: "Welcome ${company.Name}" }\n  write crm-[:Company]-> { Name: "boom ${company.Name}" }');
/** Completes. */
export const FIXED = welcoming('  write crm-[:Company]-> { Name: "Welcome ${company.Name}" }');
/** Completes, its write taking seconds. */
export const SLOW = welcoming('  write crm-[:Company]-> { Name: "slow ${company.Name}" }');
