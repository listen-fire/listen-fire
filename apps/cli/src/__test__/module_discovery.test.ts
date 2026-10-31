// `listen-fire modules`, `listen-fire modules show <module>` and `listen-fire connect --yes`
// end to end: the real binary against the modules this repository bundles, in
// a fresh project with no credential. What an agent that has only the CLI can
// find out: which modules exist, what one reads, writes and listens to, and
// how to install it without a terminal.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { parse } from 'yaml';

import { lf as lfSync } from './example';
import { lf, ok } from './interactive';

const REPO = resolve(__dirname, '../../../..');
process.env.LF_MODULES_DIR ??= join(REPO, 'modules');
process.env.LF_SERVE_MODULE ??= join(REPO, 'apps/cli/node_modules/.bin/serve-module');

function freshProject(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'lf-modules-')), 'project');
  assert.equal(lfSync(join(dir, '..'), 'init', 'project').code, 0);
  return dir;
}

function secrets(dir: string): Record<string, Record<string, unknown>> {
  const file = join(dir, '.lf/secrets.yaml');
  if (!existsSync(file)) return {};
  const parsed: unknown = parse(readFileSync(file, 'utf8')) ?? {};
  assert.ok(typeof parsed === 'object' && parsed !== null);
  return parsed as Record<string, Record<string, unknown>>;
}

function installed(dir: string): string[] {
  return readdirSync(join(dir, 'externals')).sort();
}

const BUNDLED = ['affinity', 'airtable', 'attio', 'dealroom', 'dropbox', 'email', 'evertrace', 'github', 'gmail', 'google-drive', 'google-sheets', 'granola', 'jev', 'mcp', 'pdf', 'slack', 'stripe', 'system', 'telegram', 'web', 'webhook', 'whatsapp'];

// ── the list ─────────────────────────────────────────────────────────────────

test('listen-fire modules lists every bundled module with what it is, and marks the installed ones', async () => {
  const dir = freshProject();
  const before = lfSync(dir, 'modules');
  assert.equal(before.code, 0, before.out);
  for (const name of BUNDLED) assert.match(before.out, new RegExp(`^@lf/${name} {2}not installed - \\S`, 'm'), `${name} is listed with a description`);
  assert.match(before.out, /^@lf\/stripe {2}not installed - Stripe \(customers, invoices, subscriptions\b/m);
  assert.doesNotMatch(before.out, /^@lf\/(s3-files|document-ai|wake-cloud-tasks)/m, 'slot modules installed by copying a file are not what connect @lf/<name> installs');

  const bare = lfSync(dir, 'connect');
  assert.equal(bare.out, before.out, 'a bare connect lists the same modules');

  await ok(lf(dir, ['connect', '@lf/stripe', '--yes']));
  const after = lfSync(dir, 'modules');
  assert.match(after.out, /^stripe {2}installed \(module @lf\/stripe\); install set up \(stripe\); credentials: none - Stripe \(customers/m);
  assert.doesNotMatch(after.out, /^@lf\/stripe {2}not installed/m);
  assert.match(after.out, /^@lf\/slack {2}not installed/m);

  const json = JSON.parse(lfSync(dir, 'modules', '--json').out) as { modules: Array<{ name: string; state: string; description?: string }> };
  const stripe = json.modules.find((m) => m.name === 'stripe');
  assert.equal(stripe?.state, 'installed');
  assert.match(stripe?.description ?? '', /^Stripe/);
  assert.ok(json.modules.some((m) => m.name === '@lf/slack' && m.state === 'not installed' && /^Slack/.test(m.description ?? '')));
});

// ── the summary of one module ────────────────────────────────────────────────

test('listen-fire modules show @lf/stripe says what it reads, that it is read-only and the events a listen can name, with no credential', () => {
  const dir = freshProject();
  const shown = lfSync(dir, 'modules', 'show', '@lf/stripe');
  assert.equal(shown.code, 0, shown.out);
  console.log(shown.out);
  assert.match(shown.out, /^access: read-only \(it writes nothing\)$/m);
  assert.match(shown.out, /^schema: the module's own; no account is needed/m);
  assert.match(shown.out, /^ {2}Customers -> Customer$/m);
  assert.match(shown.out, /^ {2}Invoices -> Invoice$/m);
  assert.match(shown.out, /^ {2}Subscriptions -> Subscription$/m);
  assert.match(shown.out, /^ {2}Invoice: .*\n {4}fields: .*\bStatus enum\(draft\|open\|paid\|uncollectible\|void\).*\bAmount Due number\b/m);
  assert.match(shown.out, /^ {2}Charges -> Charge$/m);
  assert.match(shown.out, /^ {4}edges: Customer -> Customer, Subscription -> Subscription\b/m);
  assert.match(shown.out, /^listens: webhook$/m);
  assert.match(shown.out, /^ {2}events: .*\binvoice\.payment_failed\b/m);
  assert.doesNotMatch(shown.out, /^writes/m);
  assert.match(shown.out, /^credential: stripe \(fields\): apiKey, webhookSecret\?$/m);
  assert.match(shown.out, /^set up: listen-fire connect @lf\/stripe --yes$/m);
  // A charge is where Stripe says why a payment failed: its record carries the failure fields.
  assert.match(shown.out, /^ {2}Charge: .*\n {4}fields: .*\bStatus enum\(succeeded\|pending\|failed\).*\bFailure Code text\b.*\bFailure Message text\b/m);
  assert.match(shown.out, /^ {2}events: .*\bcharge\.failed\b/m);

  assert.deepEqual(installed(dir), [], 'showing a module installs nothing');
  assert.deepEqual(existsSync(join(dir, '.lf/externals/stripe')), false, 'and leaves no state behind');

  const json = JSON.parse(lfSync(dir, 'modules', 'show', '@lf/stripe', '--json').out) as {
    readOnly: boolean;
    schema: { source: string };
    records: Array<{ name: string; fields: Array<{ name: string }> }>;
    listens: { events: string[] };
  };
  assert.equal(json.readOnly, true);
  assert.equal(json.schema.source, 'module');
  assert.deepEqual(json.records.map((r) => r.name).slice(0, 3), ['Customer', 'Invoice', 'Subscription']);
  assert.ok(json.records.find((r) => r.name === 'Charge')?.fields.some((f) => f.name === 'Failure Code'));
  assert.ok(json.listens.events.includes('invoice.payment_failed'));
});

test('listen-fire modules show says what a module writes, and that a module with a live schema needs an account', () => {
  const dir = freshProject();
  const slack = lfSync(dir, 'modules', 'show', '@lf/slack');
  assert.equal(slack.code, 0, slack.out);
  assert.match(slack.out, /^access: reads and writes$/m);
  assert.match(slack.out, /^ {2}a Message along Channel\.Messages: Message, File, Blocks, Buttons$/m);
  assert.match(slack.out, /^ {2}a Reaction along Message\.Reactions, write only: Emoji\*$/m);

  const airtable = lfSync(dir, 'modules', 'show', '@lf/airtable');
  assert.equal(airtable.code, 0, airtable.out);
  assert.match(airtable.out, /^schema: comes from the connected account/m);
  assert.match(airtable.out, /listen-fire credential add --module airtable <credential>/);
  assert.match(airtable.out, /^ {2}events: record\.created, record\.updated, record\.deleted$/m);
  assert.doesNotMatch(airtable.out, /^record types/m, 'a schema it never read is not described');
  assert.equal((JSON.parse(lfSync(dir, 'modules', 'show', '@lf/airtable', '--json').out) as { schema: { source: string } }).schema.source, 'account');

  const gmail = lfSync(dir, 'modules', 'show', '@lf/gmail');
  assert.match(gmail.out, /^set up: listen-fire connect @lf\/gmail --yes --client-id <your OAuth app's client id>$/m);

  const pdf = lfSync(dir, 'modules', 'show', '@lf/pdf');
  assert.equal(pdf.code, 0, pdf.out);
  assert.match(pdf.out, /pdf\.render\(text, pageSize\?, margin\?, name\?\)/);

  const unknown = lfSync(dir, 'modules', 'show', '@lf/nope');
  assert.equal(unknown.code, 1);
  assert.match(unknown.out, /no module "@lf\/nope" is installed here or bundled with this listen-fire; listen-fire modules lists them/);
});

// ── connect without a terminal ───────────────────────────────────────────────

test('listen-fire connect --yes asks nothing: a module with nothing to ask installs with its input left open', async () => {
  const dir = freshProject();
  // `lf` leaves stdin an open pipe nobody writes to, as a tool with no terminal does.
  const out = await ok(lf(dir, ['connect', '@lf/slack', '--yes']));
  assert.match(out, /^installed @lf\/slack as externals\/slack$/m);
  assert.doesNotMatch(out, /\?\s*:|\[Y\/n\]|enter generates/);
  assert.deepEqual(installed(dir), ['slack']);
  assert.match(String(secrets(dir).slack?.webhook_secret), /^[0-9a-f]{48}$/, 'the webhook secret it asked for before is generated');
  assert.match(out, /generated the secret its webhooks are signed with/);

  const given = freshProject();
  await ok(lf(given, ['connect', '@lf/slack', '--yes', '--webhook-secret', 'whsec_mine']));
  assert.equal(secrets(given).slack?.webhook_secret, 'whsec_mine');
});

test('listen-fire connect @lf/stripe installs stripe and nothing else', async () => {
  const dir = freshProject();
  const out = await ok(lf(dir, ['connect', '@lf/stripe', '--yes']));
  assert.deepEqual(installed(dir), ['stripe']);
  assert.deepEqual(Object.keys(secrets(dir)), ['stripe']);
  assert.doesNotMatch(out, /webhook/i);
});

test('listen-fire connect --yes that lacks an answer fails at once naming the flag, prints no "installed" and writes nothing', () => {
  const dir = freshProject();
  const refused = lfSync(dir, 'connect', '@lf/gmail', '--yes');
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.out, /connect @lf\/gmail --yes asks nothing, so it needs `--client-id <your OAuth app's client id>` \(nothing was written\)/);
  assert.doesNotMatch(refused.out, /installed|connected/);
  assert.deepEqual(installed(dir), [], 'the external it started to install is gone');
  assert.deepEqual(secrets(dir), {});

  const given = lfSync(dir, 'connect', '@lf/gmail', '--yes', '--client-id', 'app-id', '--client-secret', 'app-secret', '--redirect-port', '8123');
  assert.equal(given.code, 0, given.out);
  assert.match(given.out, /^installed @lf\/gmail as externals\/gmail$/m);
  assert.deepEqual(installed(dir), ['gmail']);
  assert.deepEqual(
    { id: secrets(dir).gmail?.client_id, secret: secrets(dir).gmail?.client_secret, port: String(secrets(dir).gmail?.redirect_port) },
    { id: 'app-id', secret: 'app-secret', port: '8123' },
  );

  const server = lfSync(dir, 'connect', '@acme/hubspot', '--yes');
  assert.equal(server.code, 1, server.out);
  assert.match(server.out, /needs `--url <server url>`/);
  assert.doesNotMatch(server.out, /installed/);
  assert.deepEqual(installed(dir), ['gmail']);
});

test('listen-fire connect takes a module setting as --setting, names the one it lacks, and refuses one the module does not have', () => {
  const dir = freshProject();
  const missing = lfSync(dir, 'connect', '@lf/anthropic', '--yes');
  assert.equal(missing.code, 1, missing.out);
  assert.match(missing.out, /needs `--setting api_key=<value>` \(nothing was written\)/);
  assert.deepEqual(secrets(dir), {});

  const unknown = lfSync(dir, 'connect', '@lf/anthropic', '--yes', '--setting', 'api_key=sk-test', '--setting', 'nope=1');
  assert.equal(unknown.code, 1, unknown.out);
  assert.match(unknown.out, /--setting nope: @lf\/anthropic has no such setting \(it has: api_key, base_url\)/);

  const given = lfSync(dir, 'connect', '@lf/anthropic', '--yes', '--setting', 'api_key=sk-test');
  assert.equal(given.code, 0, given.out);
  assert.equal(secrets(dir).anthropic?.api_key, 'sk-test');
});

test('listen-fire connect without --yes whose input ends names the flag that would have answered', () => {
  const dir = freshProject();
  const ended = lfSync(dir, 'connect', '@lf/gmail');
  assert.equal(ended.code, 1, ended.out);
  assert.match(ended.out, /the input ended before "your app's client id" was answered; pass --client-id <your OAuth app's client id>/);
  assert.doesNotMatch(ended.out, /^installed/m);
  assert.deepEqual(installed(dir), []);
});
