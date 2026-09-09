/**
 * Phase 6.1 boot proof — exercises a running API's mounted surface over HTTP.
 *
 *   pnpm dev:p61 --base http://localhost:3500 --shape composed
 *
 * Mints an api key against whatever database the environment points at, then
 * asks the server which surfaces it actually serves. Nothing here reaches into
 * the process; every claim is a real request.
 */

import './_profile_loader';
import '../../services';

import { randomUUID } from 'node:crypto';

import { ApiKeyService } from '../../services/api_key';
import { getCoreQb } from '../../lib/kysely';

interface Probe {
  name: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  /** What a MOUNTED deployment answers. Anything else is reported verbatim. */
  expectMounted: (status: number) => boolean;
}

const PROBES: Probe[] = [
  {
    name: 'valuations REST (write)',
    method: 'POST',
    path: '/api/v1/valuations/legal-entities',
    body: { type: 'COMPANY', name: `P61 Probe ${Date.now()}` },
    expectMounted: (s) => s === 200 || s === 201,
  },
  {
    name: 'valuations REST (read)',
    method: 'GET',
    path: '/api/v1/valuations/legal-entities?limit=1',
    expectMounted: (s) => s === 200,
  },
  {
    name: 'knowledge REST',
    method: 'GET',
    path: '/api/v1/knowledge/schema',
    expectMounted: (s) => s === 200,
  },
  {
    name: 'automation REST',
    method: 'GET',
    path: '/api/v1/automation/automations',
    expectMounted: (s) => s === 200,
  },
  {
    name: 'asks REST',
    method: 'GET',
    path: '/api/v1/asks',
    expectMounted: (s) => s === 200,
  },
  {
    name: 'billing REST (residual)',
    method: 'GET',
    path: '/api/v1/account/billing',
    expectMounted: (s) => s === 200,
  },
  {
    name: 'knowledge MCP connector',
    method: 'POST',
    path: '/api/v1/mcp/knowledge',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    expectMounted: (s) => s !== 404,
  },
  {
    name: 'valuations MCP connector',
    method: 'POST',
    path: '/api/v1/mcp/valuations',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    expectMounted: (s) => s !== 404,
  },
  {
    name: 'automation MCP connector',
    method: 'POST',
    path: '/api/v1/mcp/automation',
    body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    expectMounted: (s) => s !== 404,
  },
  {
    name: 'tRPC knowledge view',
    method: 'GET',
    path: '/api/trpc/views.knowledge.ontology.getOntologySummary?input=%7B%7D',
    expectMounted: (s) => s !== 404,
  },
  {
    name: 'tRPC movement view',
    method: 'GET',
    path: '/api/trpc/views.movement.list?input=%7B%7D',
    expectMounted: (s) => s !== 404,
  },
  {
    name: 'tRPC billing view (residual)',
    method: 'GET',
    path: '/api/trpc/views.billing.getStatus?input=%7B%7D',
    expectMounted: (s) => s !== 404,
  },
  {
    name: 'slack events door',
    method: 'POST',
    path: '/api/public/slack/events',
    body: { type: 'url_verification', challenge: 'x' },
    expectMounted: (s) => s !== 404,
  },
  {
    name: 'ask answer door',
    method: 'GET',
    path: `/api/asks/${randomUUID()}`,
    // The token is nonsense on purpose: a mounted door answers ABOUT the ask
    // (404 no such ask, or 410 with the "this link is no longer usable" page an
    // unknown or dead token renders), while an absent one answers about the
    // ROUTE. 410 is the least ambiguous of the three — express's own miss can
    // only ever be a 404.
    expectMounted: (s) => s === 404 || s === 200 || s === 410,
  },
  {
    name: 'MCP OAuth metadata (core)',
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
    expectMounted: (s) => s === 200,
  },
  {
    name: 'magic-link request (core)',
    method: 'POST',
    path: '/api/public/auth/requestMagicLink',
    body: { email: 'nobody@example.com' },
    expectMounted: (s) => s !== 404,
  },
];

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

async function mintKey(): Promise<{ key: string; teamId: string }> {
  const wanted = arg('team', '');
  const rows = await getCoreQb(['team']).selectFrom('team').select(['id']).execute();
  const teamId = wanted !== '' ? wanted : (rows[0]?.id as string | undefined);
  if (teamId === undefined) throw new Error('no team in this database — nothing to authenticate as');

  const wantedUser = arg('user', '');
  const [user] = await getCoreQb(['user']).selectFrom('user').select(['id']).limit(1).execute();
  const createdBy = wantedUser !== '' ? wantedUser : ((user?.id ?? teamId) as string);

  const { key } = await ApiKeyService.createForOwner({
    name: `p61-probe-${Date.now()}`,
    // Every coarse scope a product router asks for, so the probe reports what
    // is MOUNTED rather than what this key happens to be allowed.
    scopes: ['*', 'knowledge', 'automation', 'valuations', 'asks', 'account', 'ingest'],
    teamId,
    createdBy,
  });
  return { key, teamId };
}

async function main() {
  const base = arg('base', 'http://localhost:3500');
  const shape = arg('shape', 'composed');
  const staticKey = arg('key', '');

  const auth =
    staticKey !== '' ? { key: staticKey, teamId: '(static)' } : await mintKey();

  console.log(`\n# shape: ${shape}   base: ${base}   team: ${auth.teamId}\n`);

  for (const probe of PROBES) {
    let line: string;
    try {
      const response = await fetch(`${base}${probe.path}`, {
        method: probe.method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${auth.key}`,
        },
        ...(probe.body !== undefined ? { body: JSON.stringify(probe.body) } : {}),
      });
      const text = (await response.text()).slice(0, 160).replace(/\s+/g, ' ');
      line = `${String(response.status).padEnd(4)} ${probe.expectMounted(response.status) ? 'MOUNTED ' : 'absent  '} ${text}`;
    } catch (error) {
      line = `ERR  ${error instanceof Error ? error.message : String(error)}`;
    }
    console.log(`${probe.name.padEnd(32)} ${line}`);
  }

  console.log('');
  process.exit(0);
}

void main();
