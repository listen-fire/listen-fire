// `@lf/mcp` in listen-fire, end to end, against fake MCP servers (modules/mcp/__test__
// /fake_server.ts): two servers with different tools connected in one project,
// each by a token credential (one as a bearer, one under a header it names);
// `listen-fire check` types writes and reads of both and refuses a wrong argument;
// `listen-fire run` calls them and the answers reach the CRM; a refused call fails the
// run with the server's text; and an OAuth sign-in through the fake OAuth
// provider (packages/fake-channels) reaches a server that accepts only its
// tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { companies, project, served } from './example';
import { lf, ok } from './interactive';
import { startFakeMcpServer, type FakeMcpServer } from '../../../../modules/mcp/__test__/fake_server';

const TRIAGE = `import { acme_crm, mcp } from adapters
import { acme, linear, crm_mcp } from credentials

crm = connect acme_crm using acme
tracker = connect mcp using linear
customers = connect mcp using crm_mcp

function triage(company: <crm-[:Company]->>) {
  issue = write tracker-[:create_issue]-> { title: "Follow up \${company.Name}", team: "ENG" }
  tracker-[r:search_issues WHERE r.query == company.Name]-> {
    write crm-[:Company]-> { Name: "\${r.count} found: \${r.titles}; \${issue.text}" }
  }
  note = write customers-[:add_note]-> { customer: company.Name, body: "hello" }
  customers-[c:find_customer WHERE c.email == "ada@vireo.example"]-> {
    write crm-[:Company]-> { Name: "\${c.name} on \${c.plan}; \${note.text}" }
  }
}

listen to crm { events: ["company.created"] } fire triage
`;

/** The example project with the movement in place of the example's. */
function mcpProject(movement: string): string {
  const dir = project();
  rmSync(join(dir, 'movements/companies.mvt'));
  writeFileSync(join(dir, 'movements/triage.mvt'), movement);
  return dir;
}

/** `listen-fire connect @lf/mcp --yes`, for tokens only: no OAuth app is asked for. */
async function connectForTokens(dir: string): Promise<string> {
  return ok(lf(dir, ['connect', '@lf/mcp', '--yes'], { answers: [] }));
}

/** `listen-fire credential add` for a token credential, its fields answered as asked. */
async function addToken(dir: string, name: string, url: string, token: string, header = ''): Promise<string> {
  return ok(lf(dir, ['credential', 'add', '--module', '@lf/mcp', name, '--credential', 'mcp_token'], { answers: [url, token, header] }));
}

async function twoServers(): Promise<{ issues: FakeMcpServer; crm: FakeMcpServer; dir: string; close(): Promise<void> }> {
  const issues = await startFakeMcpServer({ kind: 'issues', token: 'linear-token' });
  const crm = await startFakeMcpServer({ kind: 'crm', token: 'crm-key', header: 'X-Api-Key' });
  const dir = mcpProject(TRIAGE);
  await connectForTokens(dir);
  assert.match(await addToken(dir, 'linear', issues.url, 'linear-token'), /added linear \(mcp, credential mcp_token\)/);
  assert.match(await addToken(dir, 'crm_mcp', crm.url, 'crm-key', 'X-Api-Key'), /added crm_mcp \(mcp, credential mcp_token\)/);
  return { issues, crm, dir, close: async () => (await issues.close(), await crm.close()) };
}

/** `listen-fire <args>`, run beside this process: the fake servers answer from it, so
 *  a synchronous spawn would leave them unable to. */
function lfAsync(dir: string, ...args: string[]): Promise<{ code: number; out: string }> {
  return lf(dir, args).done;
}

/** The movement with one line replaced, checked; its diagnostics. */
function checkWith(dir: string, from: string, to: string): Promise<{ code: number; out: string }> {
  assert.ok(TRIAGE.includes(from), from);
  writeFileSync(join(dir, 'movements/triage.mvt'), TRIAGE.replace(from, to));
  return lfAsync(dir, 'check');
}

test('two MCP servers in one project: each connection is typed by its own tools, and a run calls each with its own credential', async () => {
  const { issues, crm, dir, close } = await twoServers();
  try {
    const check = await lfAsync(dir, 'check');
    assert.equal(check.code, 0, check.out);
    console.log(check.out.trim());

    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);
    console.log(run.out.trim());
    assert.deepEqual(issues.calls, [
      { tool: 'create_issue', args: { title: 'Follow up Vireo Robotics', team: 'ENG' } },
      { tool: 'search_issues', args: { query: 'Vireo Robotics' } },
    ]);
    assert.deepEqual(crm.calls, [
      { tool: 'add_note', args: { customer: 'Vireo Robotics', body: 'hello' } },
      { tool: 'find_customer', args: { email: 'ada@vireo.example' } },
    ]);
    assert.deepEqual(companies(dir), ['1 found: Follow up Vireo Robotics; created ENG-2: Follow up Vireo Robotics', 'ada on pro; noted on Vireo Robotics']);
    // Each server saw only its own credential.
    assert.ok(issues.presented.length > 0 && issues.presented.every((p) => p === 'Bearer linear-token'));
    assert.ok(crm.presented.length > 0 && crm.presented.every((p) => p === 'crm-key'));
  } finally {
    await close();
  }
});

test('listen-fire check refuses a wrong argument type, a value the tool does not take, and a tool only the other server has', async () => {
  const { dir, close } = await twoServers();
  try {
    const wrongType = await checkWith(dir, 'team: "ENG" }', 'team: "ENG", priority: "high" }');
    assert.equal(wrongType.code, 1, wrongType.out);
    assert.match(wrongType.out, /MOV_WRITE_FIELD_TYPE 'priority' on tracker\.create_issue is number, but this expression produces text/);

    const wrongPin = await checkWith(dir, 'r.query == company.Name', 'r.query == 5');
    assert.equal(wrongPin.code, 1, wrongPin.out);
    assert.match(wrongPin.out, /MOV_COMPARE_TYPE_MISMATCH Can't compare a text to a number/);

    const wrongValue = await checkWith(dir, 'team: "ENG" }', 'team: "QA" }');
    assert.equal(wrongValue.code, 1, wrongValue.out);
    assert.match(wrongValue.out, /MOV_ENUM_UNKNOWN_VALUE "QA" isn't a value of enum \(ENG \| OPS\)/);

    const otherServers = await checkWith(dir, 'write customers-[:add_note]->', 'write customers-[:create_issue]->');
    assert.equal(otherServers.code, 1, otherServers.out);
    assert.match(otherServers.out, /MOV_LINKED_UNKNOWN_EDGE 'customers' \(the instance itself\) has no edge 'create_issue' .* it declares: find_customer, add_note/);
    console.log([wrongType, wrongPin, wrongValue, otherServers].map((c) => c.out.trim()).join('\n'));
  } finally {
    await close();
  }
});

test('a call the server refuses fails the run with the server’s text', async () => {
  const { issues, dir, close } = await twoServers();
  try {
    writeFileSync(join(dir, 'movements/triage.mvt'), TRIAGE.replace('title: "Follow up ${company.Name}"', 'title: "fail"'));
    assert.equal((await lfAsync(dir, 'check')).code, 0);
    const refused = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /create_issue: team ENG does not take issues titled "fail"/);
    console.log(refused.out.trim());
    assert.deepEqual(issues.calls.map((c) => c.tool), ['create_issue']);

  } finally {
    await close();
  }
});

test('a flaky server: a 429 on a write and a 500 on a read are retried, and a run still completes', async () => {
  const { issues, dir, close } = await twoServers();
  try {
    const check = await lfAsync(dir, 'check');
    assert.equal(check.code, 0, check.out);
    issues.faults.push({ rpc: 'tools/call', tool: 'create_issue', status: 429, retryAfter: '1' }, { rpc: 'tools/call', tool: 'search_issues', status: 500 });
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);
    // The write was sent once to the server's logic (the 429 never reached it); the read twice at the wire.
    assert.equal(issues.calls.filter((c) => c.tool === 'create_issue').length, 1);
    assert.equal(issues.requests.filter((r) => r === 'tools/call:create_issue').length, 2);
    assert.equal(issues.requests.filter((r) => r === 'tools/call:search_issues').length, 2);
  } finally {
    await close();
  }
});

/** One webhook delivery to `listen-fire serve` at the example's door, signed as the CRM signs it; the runs it fired. */
async function deliverToServe(dir: string, port: number): Promise<Array<{ status: string; error?: string }>> {
  const body = readFileSync(join(dir, 'events/webhook_body.json'));
  const signature = createHmac('sha256', 'dev-acme-webhook-secret').update(body).digest('hex');
  const response = await fetch(`http://127.0.0.1:${port}/hooks/acme_crm/acme`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-listen-fire-signature': signature },
    body,
  });
  assert.equal(response.status, 202, await response.clone().text());
  return ((await response.json()) as { runs: Array<{ status: string; error?: string }> }).runs;
}

// `@lf/mcp` declares hostLimits, so under `listen-fire serve` it asks the limits door
// on serve's own listener, from the describe at startup on.
for (const host of ['listen-fire run', 'listen-fire serve'] as const) {
  test(`${host}: a 429 with Retry-After on a write and a 503 on a read are retried, and the run completes`, async () => {
    const { issues, dir, close } = await twoServers();
    try {
      issues.faults.push({ rpc: 'tools/call', tool: 'create_issue', status: 429, retryAfter: '1' }, { rpc: 'tools/call', tool: 'search_issues', status: 503 });
      if (host === 'listen-fire run') {
        const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
        assert.equal(run.code, 0, run.out);
      } else {
        const serving = await served(dir);
        try {
          const runs = await deliverToServe(dir, serving.port);
          assert.deepEqual(runs.map((r) => [r.status, r.error]), [['completed', undefined]]);
        } finally {
          await serving.stop();
        }
      }
      assert.equal(issues.calls.filter((c) => c.tool === 'create_issue').length, 1);
      assert.equal(issues.requests.filter((r) => r === 'tools/call:create_issue').length, 2);
      assert.equal(issues.requests.filter((r) => r === 'tools/call:search_issues').length, 2);
    } finally {
      await close();
    }
  });
}

test('a 500 on a tool that changes things fails the run without a second try', async () => {
  const { issues, dir, close } = await twoServers();
  try {
    assert.equal((await lfAsync(dir, 'check')).code, 0);
    issues.faults.push({ rpc: 'tools/call', tool: 'create_issue', status: 500 });
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 1, run.out);
    assert.match(run.out, /500/);
    assert.equal(issues.requests.filter((r) => r === 'tools/call:create_issue').length, 1);
  } finally {
    await close();
  }
});

test('listen-fire check refuses a read that does not pin a required argument in its WHERE, and accepts the pinned form', async () => {
  const { issues, dir, close } = await twoServers();
  try {
    const bare = await checkWith(dir, 'tracker-[r:search_issues WHERE r.query == company.Name]->', 'tracker-[r:search_issues]->');
    assert.equal(bare.code, 1, bare.out);
    assert.match(bare.out, /MOV_HOP_PIN_REQUIRED 'search_issues' takes `query` as an argument of the read, so its WHERE must pin it with ==/);
    assert.match(bare.out, /Write `-\[r:search_issues WHERE r\.query == …\]->`/);

    const otherField = await checkWith(dir, 'r.query == company.Name', 'r.count == 1');
    assert.equal(otherField.code, 1, otherField.out);
    assert.match(otherField.out, /MOV_HOP_PIN_REQUIRED 'search_issues' takes `query`/);

    const either = await checkWith(dir, 'r.query == company.Name', '(r.query == company.Name OR r.query == "x")');
    assert.equal(either.code, 1, either.out);
    assert.match(either.out, /MOV_HOP_PIN_REQUIRED/);
    console.log([bare, otherField, either].map((c) => c.out.trim()).join('\n'));

    const pinned = await checkWith(dir, 'r.query == company.Name', 'r.count >= 0 AND company.Name == r.query');
    assert.equal(pinned.code, 0, pinned.out);
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);
    assert.deepEqual(issues.calls.find((c) => c.tool === 'search_issues'), { tool: 'search_issues', args: { query: 'Vireo Robotics' } });
  } finally {
    await close();
  }
});

test('listen-fire connect @lf/mcp for tokens asks for no OAuth app, and an OAuth credential is then refused naming the remedy', async () => {
  const dir = mcpProject(TRIAGE);
  const quiet = await connectForTokens(dir);
  console.log(quiet.trim());
  assert.match(quiet, /installed @lf\/mcp as externals\/mcp/);
  assert.doesNotMatch(quiet, /client id/);
  assert.match(quiet, /mcp: no OAuth app, so its OAuth sign-in \(mcp\) is off; listen-fire connect mcp again sets one up/);

  // Asked, an empty answer is no.
  const asked = await ok(lf(dir, ['connect', '@lf/mcp'], { answers: [''] }));
  assert.match(asked, /set up your OAuth app at the provider now\? \[y\/N\]/);
  assert.doesNotMatch(asked, /client id/);

  const refused = await lf(dir, ['credential', 'add', '--module', '@lf/mcp', 'ops', '--credential', 'mcp'], { answers: [] }).done;
  assert.equal(refused.code, 1, refused.out);
  console.log(refused.out.trim());
  assert.match(
    refused.out,
    /module "mcp" has no OAuth app set up, so its "mcp" credential cannot sign in: listen-fire connect mcp and answer yes to the OAuth app, or listen-fire connect mcp --oauth-authorize-url <url> --oauth-token-url <url>/,
  );
});

interface Fake {
  url: string;
  stop(): Promise<void>;
}

/** `@listen-fire/fake-channels` (its OAuth provider) on a free port. */
async function fakeChannels(): Promise<Fake> {
  const cwd = mkdtempSync(join(tmpdir(), 'lf-mcp-oauth-'));
  const child: ChildProcess = spawn(process.execPath, [require.resolve('@listen-fire/fake-channels/bin/fake-channels.cjs')], {
    cwd,
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

test('OAuth: listen-fire connect with the provider’s endpoints, a headless sign-in, and the server accepts only the provider’s token', async () => {
  const provider = await fakeChannels();
  const server = await startFakeMcpServer({ kind: 'issues', introspect: `${provider.url}/oauth/protected` });
  try {
    const dir = mcpProject(
      TRIAGE.replace('import { acme, linear, crm_mcp } from credentials', 'import { acme, linear } from credentials')
        .replace(/customers = .*\n/, '')
        .replace(/  note = [\s\S]*?\n  }\n/, ''),
    );
    const F = provider.url;
    const connected = await ok(
      lf(dir, ['connect', '@lf/mcp', '--yes', '--oauth-authorize-url', `${F}/oauth/authorize`, '--oauth-token-url', `${F}/oauth/token`], {
        answers: ['lf-mcp-app', 'lf-mcp-secret', '8977'],
      }),
    );
    assert.match(connected, /installed @lf\/mcp as externals\/mcp/);

    const adding = lf(dir, ['credential', 'add', '--module', '@lf/mcp', 'linear', '--credential', 'mcp', '--headless'], { answers: [server.url] });
    const authorize = (await adding.line(/^\s+http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?/)).trim();
    assert.equal(new URL(authorize).searchParams.get('code_challenge_method'), 'S256');
    const consent = await fetch(authorize, { redirect: 'manual' });
    const location = consent.headers.get('location');
    assert.ok(location !== null, 'the fake provider redirects back with a code');
    await adding.line(/paste the URL your browser was sent back to/);
    adding.answer(location);
    assert.match(await ok(adding), /added linear \(mcp, credential mcp\)/);

    const check = await lfAsync(dir, 'check');
    assert.equal(check.code, 0, check.out);
    const run = await lfAsync(dir, 'run', '--event', 'events/company_created.json');
    assert.equal(run.code, 0, run.out);
    console.log(run.out.trim());
    assert.deepEqual(server.calls.map((c) => c.tool), ['create_issue', 'search_issues']);
    assert.ok(server.presented.every((p) => /^Bearer \S+$/.test(p) && p !== 'Bearer '));
  } finally {
    await server.close();
    await provider.stop();
  }
});
