/**
 * Phase 4.1 verification: the express auth funnel is now a Principal provider.
 *
 * Everything here goes over the WIRE against a running dev-loop stack — the
 * point of the phase is that the credential chain, the refusal shapes, and the
 * team gate are unchanged when the ~200-line if/else becomes
 * `CorePrincipalProvider` + product-owned inbound doors. Only a provider
 * exercised through express (and through the websocket handshake, which is the
 * provider's second call site) can prove that.
 *
 * Run with the stack up:
 *   DEV_LOOP_PROFILE=<profile> pnpm --filter api dev:verify-phase41-auth
 * or the same ts-node invocation the other dev/verify_*.ts scripts use.
 */
import './_profile_loader';

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';

import { DEV_LOOP_EMAIL } from './_lib';
import {
  buildMailgunRequestBody,
  DEFAULT_MAILGUN_API_KEY,
  DEFAULT_MAILGUN_FIXTURE,
} from './inject';
import { getAutomationsQb, getCoreQb } from '../../lib/kysely';
import { generateJWT, generateRealtimeToken } from '../../lib/middleware/authentication/token';
import { ApiKeyService } from '../../services/api_key';

const API = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

interface CheckResult {
  id: string;
  name: string;
  pass: boolean | 'blocked';
  evidence: unknown;
}

const results: CheckResult[] = [];

function record(id: string, name: string, pass: boolean | 'blocked', evidence: unknown) {
  results.push({ id, name, pass, evidence });
  const tag = pass === true ? 'PASS' : pass === 'blocked' ? 'BLOCKED' : 'FAIL';
  console.log(`[${tag}] ${id} ${name}`);
  console.log(`       ${JSON.stringify(evidence)}`);
}

interface Wire {
  status: number;
  body: string;
  json: unknown;
  contentLength: string | null;
}

async function wire(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Wire> {
  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = await res.text();
  let json: unknown;
  try {
    json = body === '' ? undefined : JSON.parse(body);
  } catch {
    json = undefined;
  }
  return { status: res.status, body, json, contentLength: res.headers.get('content-length') };
}

/**
 * One tRPC query over the websocket, authenticated by the `ListenFireToken`
 * subprotocol.
 *
 * The handshake is driven by hand rather than through node's `ws` client
 * because the SEPARATOR is part of what is under test: browsers send
 * `"ListenFireToken, <token>"`, node's `ws` sends `"ListenFireToken,<token>"`, and the
 * server has to read a token out of both. `ws` builds that header itself and
 * will not let a caller hand it the browser's bytes.
 */
function wsQuery(
  header: string,
  path: string,
): Promise<{ ok: boolean; handshake?: number; message: unknown }> {
  return new Promise((resolve) => {
    const target = new URL(`${API}/subscriptions/trpc`);
    const req = http.request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Protocol': header,
      },
    });

    let settled = false;
    const done = (value: { ok: boolean; handshake?: number; message: unknown }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => done({ ok: false, message: 'timeout after 20s' }), 20_000);

    req.on('response', (res) => done({ ok: false, handshake: res.statusCode, message: 'no upgrade' }));
    req.on('error', (err) => done({ ok: false, message: err.message }));

    req.on('upgrade', (res, socket) => {
      const payload = Buffer.from(
        JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'query', params: { path, input: null } }),
      );
      // A single masked text frame — the only client frame this probe sends.
      const mask = randomBytes(4);
      const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
      const headerBytes =
        payload.length < 126
          ? Buffer.from([0x81, 0x80 | payload.length])
          : Buffer.concat([
              Buffer.from([0x81, 0x80 | 126]),
              (() => {
                const len = Buffer.alloc(2);
                len.writeUInt16BE(payload.length);
                return len;
              })(),
            ]);
      socket.write(Buffer.concat([headerBytes, mask, masked]));

      let buffer = Buffer.alloc(0);
      socket.on('data', (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        // Server frames are never masked.
        for (;;) {
          if (buffer.length < 2) return;
          const short = buffer[1] & 0x7f;
          let offset = 2;
          let length = short;
          if (short === 126) {
            if (buffer.length < 4) return;
            length = buffer.readUInt16BE(2);
            offset = 4;
          } else if (short === 127) {
            if (buffer.length < 10) return;
            length = Number(buffer.readBigUInt64BE(2));
            offset = 10;
          }
          if (buffer.length < offset + length) return;
          const frame = buffer.subarray(offset, offset + length).toString();
          buffer = buffer.subarray(offset + length);

          let parsed: {
            id?: number;
            result?: { data?: unknown };
            error?: { message?: string; data?: { code?: string } };
          };
          try {
            parsed = JSON.parse(frame);
          } catch {
            continue;
          }
          if (parsed.id !== 1) continue;
          if (parsed.error) {
            // The stack is megabytes of noise in a report; message + code is
            // the whole signal.
            return done({
              ok: false,
              handshake: res.statusCode,
              message: { message: parsed.error.message, code: parsed.error.data?.code },
            });
          }
          return done({ ok: true, handshake: res.statusCode, message: parsed.result?.data });
        }
      });
      socket.on('close', () => done({ ok: false, message: 'closed before answering' }));
    });

    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const teamId = process.env.TEST_HARNESS_TEAM_ID!;
  const user = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['id', 'username', 'default_team_id'])
    .where('default_team_id', '=', teamId as never)
    .executeTakeFirstOrThrow();

  const session = generateJWT(DEV_LOOP_EMAIL);
  const cookie = { Cookie: `listen_fire_token=${session}` };

  // ---------------------------------------------------------------- 1. cookie
  {
    const r = await wire('/api/v1/me', { headers: cookie });
    const me = r.json as { id?: string; email?: string } | undefined;
    record('1', 'cookie session on a private REST route', r.status === 200 && me?.id === user.id, {
      status: r.status,
      body: r.json,
      expectedUserId: user.id,
      devTeamId: teamId,
    });
  }

  // ------------------------------------------------------------ 2. no cred
  {
    const r = await wire('/api/v1/me');
    record('2', 'no credential → 403 with an empty body', r.status === 403 && r.body === '', {
      status: r.status,
      body: r.body,
      contentLength: r.contentLength,
    });
  }

  // -------------------------------------------------------- 3. bad api key
  {
    const r = await wire('/api/v1/me', { headers: { Authorization: 'Bearer az_totally_invalid' } });
    record(
      '3',
      'invalid api key → 401 Invalid API key',
      r.status === 401 && r.body === '{"error":{"code":401,"message":"Invalid API key"}}',
      { status: r.status, body: r.body },
    );
  }

  // --------------------------------------------------------- 4. bad cookie
  {
    const r = await wire('/api/v1/me', { headers: { Cookie: 'listen_fire_token=garbage' } });
    record(
      '4',
      'garbage cookie → 401 Invalid or expired session',
      r.status === 401 && r.body === '{"error":{"code":401,"message":"Invalid or expired session"}}',
      { status: r.status, body: r.body },
    );
  }

  // ------------------------------------------------------- 5. api key scopes
  // User-anchored (`teamId: null`), the shape the MCP/agent connectors mint.
  const minted = await ApiKeyService.createForOwner({
    name: `phase41 probe ${Date.now()}`,
    scopes: ['knowledge', 'automation'],
    teamId: null,
    createdBy: user.id,
  });
  const keyHeader = { Authorization: `Bearer ${minted.key}` };

  try {
    {
      const r = await wire('/api/v1/knowledge/schema', { headers: keyHeader });
      record('5a', 'api key with `knowledge` → 200 on /v1/knowledge/schema', r.status === 200, {
        status: r.status,
        bodyPreview: r.body.slice(0, 200),
      });
    }
    {
      const r = await wire('/api/v1/valuations/funds', { headers: keyHeader });
      record(
        '5b',
        'api key lacking `valuations` → 403 missing-scope (res.locals.apiKeyScopes flows)',
        r.status === 403 && r.body === '{"error":"API key missing required scope: valuations"}',
        { status: r.status, body: r.body },
      );
    }
    {
      const r = await wire('/api/v1/valuations/funds', { headers: cookie });
      record(
        '5c',
        'SESSION cookie on a scoped route → 403 missing-scope, NOT access',
        r.status === 403 && r.body === '{"error":"API key missing required scope: valuations"}',
        { status: r.status, body: r.body },
      );
    }
    {
      // Edge: a revoked key must fall back to the invalid-key refusal.
      const throwaway = await ApiKeyService.createForOwner({
        name: `phase41 revoked ${Date.now()}`,
        scopes: ['knowledge'],
        teamId: null,
        createdBy: user.id,
      });
      await ApiKeyService.revokeById(throwaway.id);
      const r = await wire('/api/v1/me', {
        headers: { Authorization: `Bearer ${throwaway.key}` },
      });
      record(
        '5d',
        'revoked api key → 401 Invalid API key',
        r.status === 401 && r.body === '{"error":{"code":401,"message":"Invalid API key"}}',
        { status: r.status, body: r.body },
      );
    }

    {
      // The other place a key may arrive.
      const r = await wire('/api/v1/me', { headers: { 'x-api-key': minted.key } });
      record('5e', 'api key via the `x-api-key` header authenticates too', r.status === 200, {
        status: r.status,
        body: r.json,
      });
    }

    // ------------------------------------------------- 6. team through provider
    {
      const r = await wire('/api/v1/automation/teams', { headers: keyHeader });
      const teams = (r.json as { teams?: Array<Record<string, unknown>> } | undefined)?.teams ?? [];
      const dev = teams.find((t) => t.teamId === teamId);
      record(
        '6a',
        'listTeams through the provider names the dev team + isPersonal',
        r.status === 200 &&
          dev !== undefined &&
          typeof dev.name === 'string' &&
          dev.name.length > 0 &&
          typeof dev.isPersonal === 'boolean',
        { status: r.status, teams },
      );
    }
    {
      // `resolveToolTeam` path: the knowledge schema route resolves the acting
      // team through the provider before it reads anything.
      const r = await wire(`/api/v1/knowledge/schema?team=${teamId}`, { headers: keyHeader });
      const explicit = r.status === 200;
      const bad = await wire('/api/v1/knowledge/schema?team=11111111-2222-3333-4444-555555555555', {
        headers: keyHeader,
      });
      record(
        '6b',
        'resolveToolTeam accepts the dev team and refuses a foreign one',
        explicit && bad.status === 400,
        {
          explicitTeam: { status: r.status },
          foreignTeam: { status: bad.status, body: bad.body.slice(0, 200) },
        },
      );
    }

    // ------------------------------------------------------ 7. team override
    {
      const r = await wire('/api/v1/me', {
        headers: { ...cookie, 'x-request-team-id': '11111111-2222-3333-4444-555555555555' },
      });
      record(
        '7a',
        'x-request-team-id for a team you are not in → 403',
        r.status === 403 &&
          r.body ===
            '{"error":{"code":403,"message":"The requested team is not one you have access to."}}',
        { status: r.status, body: r.body },
      );
    }
    {
      const r = await wire('/api/v1/me', {
        headers: { ...cookie, 'x-request-team-id': 'undefined' },
      });
      record(
        '7b',
        'x-request-team-id: the literal string "undefined" is treated as absent',
        r.status === 200,
        { status: r.status, body: r.json },
      );
    }
    {
      const r = await wire('/api/v1/me', { headers: { ...cookie, 'x-request-team-id': teamId } });
      record('7c', 'x-request-team-id for your own team → 200', r.status === 200, {
        status: r.status,
        body: r.json,
      });
    }

    {
      // A key PINNED to a team may not be escaped by a divergent override —
      // the other branch of the acting-team resolution.
      const pinned = await ApiKeyService.createForOwner({
        name: `phase41 pinned ${Date.now()}`,
        scopes: ['knowledge'],
        teamId,
        createdBy: user.id,
      });
      try {
        const r = await wire('/api/v1/me', {
          headers: {
            Authorization: `Bearer ${pinned.key}`,
            'x-request-team-id': '11111111-2222-3333-4444-555555555555',
          },
        });
        const ok = await wire('/api/v1/me', {
          headers: { Authorization: `Bearer ${pinned.key}`, 'x-request-team-id': teamId },
        });
        record(
          '7d',
          'a team-pinned api key cannot be escaped by x-request-team-id',
          r.status === 403 &&
            r.body ===
              '{"error":{"code":403,"message":"This API key is scoped to a team; the request-team override may not escape it."}}' &&
            ok.status === 200,
          { divergent: { status: r.status, body: r.body }, agreeing: { status: ok.status } },
        );
      } finally {
        await ApiKeyService.revokeById(pinned.id);
      }
    }

    // ------------------------------------------------------- 8. WS realtime
    let realtime: string | null = null;
    {
      const r = await wire('/api/public/auth/realtime-token', { headers: cookie });
      const token = (r.json as { token?: string } | undefined)?.token;
      if (typeof token === 'string') realtime = token;
      record('8a', 'GET /api/public/auth/realtime-token with the session cookie', r.status === 200, {
        status: r.status,
        body: r.body.slice(0, 200),
      });
    }
    {
      // If the HTTP mint is unavailable, still drive the handshake with a token
      // minted the same way the route mints it — the websocket half is what
      // phase 4.1 changed.
      const source = realtime === null ? 'minted in-process (route unavailable)' : 'route';
      const token = realtime ?? generateRealtimeToken(DEV_LOOP_EMAIL);
      // `views.*` is a `userProcedure` — the one that calls `authorise()`, which
      // is the ONLY thing that establishes identity over the websocket.
      // Both separators, because both kinds of client exist: `", "` is what a
      // browser sends, `","` is what node's `ws` sends.
      for (const [label, header] of [
        ['browser form ", "', `ListenFireToken, ${token}`],
        ['node-ws form ","', `ListenFireToken,${token}`],
      ] as const) {
        const answer = await wsQuery(header, 'views.userSettings.getEmails');
        const emails = answer.message as Array<{ email?: string }> | undefined;
        record(
          label.startsWith('browser') ? '8b' : '8b2',
          `tRPC WS query authenticated by the ListenFireToken subprotocol (${label})`,
          answer.ok === true &&
            Array.isArray(emails) &&
            emails.some((e) => e.email === DEV_LOOP_EMAIL),
          { tokenSource: source, handshake: answer.handshake, answer: answer.message },
        );
      }
    }
    {
      const answer = await wsQuery(
        'ListenFireToken, garbage-realtime-token',
        'views.userSettings.getEmails',
      );
      const err = answer.message as { message?: string; code?: string } | undefined;
      record(
        '8c',
        'tRPC WS with a garbage subprotocol token → UNAUTHORIZED',
        answer.ok === false && err?.code === 'UNAUTHORIZED',
        { answer: answer.message },
      );
    }
    {
      // The gap 4.1 pinned here — `modelsRouter` handing `models/user.ts` the
      // RAW `trpc.procedure`, so `authorise()` never ran and a valid token got
      // a 500 "Missing user" over the websocket — is closed in 4.2. The check
      // is inverted rather than deleted: it now proves the router answers.
      const answer = await wsQuery(
        `ListenFireToken, ${generateRealtimeToken(DEV_LOOP_EMAIL)}`,
        'models.user.context',
      );
      record(
        '8d',
        'models.user.* goes through userProcedure → a valid WS token gets an answer',
        answer.ok === true,
        { answer: answer.ok === true ? 'answered' : answer.message },
      );
    }

    // ------------------------------------------ 9/10. inbound door + a real run
    {
      const before = await getAutomationsQb(['trigger_run'])
        .selectFrom('trigger_run')
        .select('id')
        .execute();
      const seen = new Set(before.map((r) => r.id as string));

      const fixture = JSON.parse(fs.readFileSync(DEFAULT_MAILGUN_FIXTURE, 'utf-8')) as Record<
        string,
        unknown
      >;
      const to = 'inbox+dealflow-intake@example.com';

      // 10a — a bad signature is refused by the door's own status.
      const bad = buildMailgunRequestBody({
        fixture,
        to,
        apiKey: DEFAULT_MAILGUN_API_KEY,
      }) as Record<string, unknown>;
      bad.signature = 'deadbeef'.repeat(8);
      const badRes = await wire('/api/mailgun/callback', { method: 'POST', body: bad });
      record('10a', 'mailgun inbound door refuses a bad signature', badRes.status === 406, {
        status: badRes.status,
        body: badRes.body,
      });

      // 10b — a good signature is accepted.
      const good = buildMailgunRequestBody({ fixture, to, apiKey: DEFAULT_MAILGUN_API_KEY });
      const goodRes = await wire('/api/mailgun/callback', { method: 'POST', body: good });
      record('10b', 'mailgun inbound door accepts a signed payload', goodRes.status === 201, {
        status: goodRes.status,
        body: goodRes.body,
      });

      // 9 — the run that payload triggers must reach success under the worker's
      // own ambient principal.
      let runs: Array<{ id: string; status: string; trigger_type: string; failure_reason: string | null }> = [];
      for (let i = 0; i < 40; i += 1) {
        await sleep(1500);
        const rows = await getAutomationsQb(['trigger_run'])
          .selectFrom('trigger_run')
          .select(['id', 'status', 'trigger_type', 'failure_reason'])
          .orderBy('created_at', 'desc')
          .limit(10)
          .execute();
        runs = (rows as unknown as typeof runs).filter((r) => !seen.has(r.id));
        if (runs.length > 0 && runs.every((r) => r.status !== 'running')) break;
      }
      record(
        '9',
        'the movement run the inbound email triggers reaches success',
        runs.length > 0 && runs.every((r) => r.status === 'success'),
        { newRuns: runs },
      );
    }
  } finally {
    await ApiKeyService.revokeById(minted.id);
  }

  const failed = results.filter((r) => r.pass !== true);
  console.log('\n================ SUMMARY ================');
  for (const r of results) {
    console.log(`${r.pass === true ? 'PASS   ' : r.pass === 'blocked' ? 'BLOCKED' : 'FAIL   '} ${r.id}  ${r.name}`);
  }
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) {
    console.log('\nFAILURES:');
    console.log(JSON.stringify(failed, null, 2));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
