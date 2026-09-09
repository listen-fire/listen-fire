/**
 * Affinity Org List Entries Script
 *
 * Finds all list entries for an organisation by name, showing when each
 * entry was created and which list it belongs to.
 *
 * Environment variables:
 *   DATABASE_URL              - Postgres connection string (for credential lookup)
 *   ENCRYPTION_MASTER_KEY     - Base64 master key (for decrypting stored credentials)
 *   ENCRYPTION_SALT_BASE64    - Base64 salt (for HKDF key derivation)
 *   AFFINITY_CREDENTIAL_ID    - UUID of the credential row in external_service_credentials
 *   ORG_NAME                  - Name of the organisation to search for (required)
 *   MAX_API_CALLS             - Hard cap on total Affinity API calls (default: 20)
 *
 *   Alternatively, skip DB lookup by providing the key directly:
 *   AFFINITY_API_KEY          - Your Affinity API key (overrides DB lookup)
 *
 * Usage:
 *   ORG_NAME="Acme Corp" npx tsx affinity-org-list-entries.ts
 */

import { hkdf, createDecipheriv } from 'node:crypto';

const ORG_NAME = process.env.ORG_NAME;
const BASE_URL = 'https://api.affinity.co';
const MAX_API_CALLS = Number(process.env.MAX_API_CALLS) || 20;

let apiCallCount = 0;

// ── Credential decryption (mirrors apps/api/src/lib/credentials.ts) ─────────

async function deriveDEK(masterKey: Buffer, salt: Buffer, context: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    hkdf('sha256', masterKey, salt, Buffer.from(context), 32, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

async function decryptToken(
  data: Buffer,
  context: string,
  masterKey: Buffer,
  salt: Buffer,
): Promise<string> {
  const nonce = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(12, data.length - 16);

  const key = await deriveDEK(masterKey, salt, context);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

async function fetchApiKeyFromDb(): Promise<{ apiKey: string; baseUrl?: string }> {
  const credentialId = process.env.AFFINITY_CREDENTIAL_ID;
  const databaseUrl = process.env.DATABASE_URL;
  const masterKeyB64 = process.env.ENCRYPTION_MASTER_KEY;
  const saltB64 = process.env.ENCRYPTION_SALT_BASE64;

  if (!credentialId || !databaseUrl || !masterKeyB64 || !saltB64) {
    throw new Error(
      'DB credential lookup requires: DATABASE_URL, ENCRYPTION_MASTER_KEY, ENCRYPTION_SALT_BASE64, AFFINITY_CREDENTIAL_ID',
    );
  }

  const masterKey = Buffer.from(masterKeyB64, 'base64');
  const salt = Buffer.from(saltB64, 'base64');

  const pg = await import('pg');
  const PgClient = pg.default?.Client ?? pg.Client;
  const client = new PgClient({ connectionString: databaseUrl });
  await client.connect();

  try {
    const result = await client.query(
      `SELECT id, credentials FROM external_service_credentials WHERE id = $1 AND type = 'AFFINITY'`,
      [credentialId],
    );

    if (result.rows.length === 0) {
      throw new Error(`No AFFINITY credential found with id ${credentialId}`);
    }

    const row = result.rows[0];
    const decrypted = await decryptToken(row.credentials, row.id, masterKey, salt);
    const parsed = JSON.parse(decrypted);

    if (!parsed.apiKey) {
      throw new Error('Decrypted credential does not contain apiKey');
    }

    console.error('Successfully decrypted Affinity API key from database.');
    return { apiKey: parsed.apiKey, baseUrl: parsed.baseUrl };
  } finally {
    await client.end();
  }
}

async function resolveApiKey(): Promise<string> {
  if (process.env.AFFINITY_API_KEY) {
    return process.env.AFFINITY_API_KEY;
  }
  const creds = await fetchApiKeyFromDb();
  return creds.apiKey;
}

let API_KEY: string;

// ── API helpers ─────────────────────────────────────────────────────────────

function authHeader(): string {
  return 'Basic ' + Buffer.from(':' + API_KEY).toString('base64');
}

function remainingCalls(): number {
  return MAX_API_CALLS - apiCallCount;
}

async function affinityGet<T = unknown>(path: string, query?: Record<string, string>): Promise<T> {
  if (apiCallCount >= MAX_API_CALLS) {
    throw new Error(
      `API call limit reached (${MAX_API_CALLS}/${MAX_API_CALLS}). Increase MAX_API_CALLS to fetch more.`,
    );
  }
  apiCallCount++;
  const url = new URL(BASE_URL + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  }

  console.error(`  [${apiCallCount}] GET ${url.pathname}${url.search}`);

  const res = await fetch(url, { headers: { Authorization: authHeader() } });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Affinity ${res.status} on ${path}: ${text}`);
  }

  return res.json() as Promise<T>;
}

async function paginateAll<T>(
  path: string,
  key: string,
  query?: Record<string, string>,
): Promise<T[]> {
  const all: T[] = [];
  let pageToken: string | undefined;

  do {
    if (remainingCalls() <= 0) {
      console.error(`  Pagination stopped — API call limit reached.`);
      break;
    }
    const q = { ...query, page_size: '500', ...(pageToken ? { page_token: pageToken } : {}) };
    const res = await affinityGet<Record<string, unknown>>(path, q);
    const items = res[key] as T[] | undefined;
    if (items) all.push(...items);
    pageToken = res.next_page_token as string | undefined;
  } while (pageToken);

  return all;
}

// ── Types ───────────────────────────────────────────────────────────────────

interface AffinityList {
  id: number;
  name: string;
  type: number;
  list_size: number;
}

interface ListEntry {
  id: number;
  entity_id: number;
  entity_type: number;
  entity: { id: number; name?: string; domain?: string } | null;
  created_at: string;
  list_id: number;
}

interface Organization {
  id: number;
  name: string | null;
  domain: string | null;
  list_entries: { id: number; list_id: number; created_at: string }[];
}

// ── Main logic ──────────────────────────────────────────────────────────────

async function findOrgListEntries() {
  if (!ORG_NAME) {
    console.error('Missing ORG_NAME. Set it to the organisation name to search for.');
    process.exit(1);
  }

  // 1. Search for the organisation by name
  console.error(`\nSearching for organisation: "${ORG_NAME}"...`);
  const searchResults = await affinityGet<{ organizations: Organization[] }>('/organizations', {
    term: ORG_NAME,
  });

  const orgs = searchResults.organizations;
  if (!orgs || orgs.length === 0) {
    console.error('No organisations found matching that name.');
    process.exit(1);
  }

  // Find exact match first, fall back to first result
  const exactMatch = orgs.find((o) => o.name?.toLowerCase() === ORG_NAME.toLowerCase());
  const org = exactMatch ?? orgs[0];

  if (!exactMatch && orgs.length > 1) {
    console.error(`No exact match. Found ${orgs.length} results, using first: "${org.name}"`);
    console.error('Other matches:');
    for (const o of orgs.slice(1, 5)) {
      console.error(`  - ${o.name} (id: ${o.id})`);
    }
  }

  console.error(`\nOrganisation: ${org.name} (id: ${org.id})`);

  // 2. Fetch full org details (includes list_entries)
  const orgDetail = await affinityGet<Organization>(`/organizations/${org.id}`);

  if (!orgDetail.list_entries || orgDetail.list_entries.length === 0) {
    console.log(`\n"${org.name}" has no list entries.`);
    console.log(`\nTotal API calls: ${apiCallCount}/${MAX_API_CALLS}`);
    return;
  }

  // 3. Fetch list names for context
  console.error(`\nFetching list details...`);
  const lists = await affinityGet<AffinityList[]>('/lists');
  const listNameMap = new Map(lists.map((l) => [l.id, l.name]));

  // 4. Output
  const entries = orgDetail.list_entries.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  console.log(`\n=== List Entries for "${org.name}" ===\n`);

  const header = 'List'.padEnd(40) + 'Entry ID'.padEnd(14) + 'Created At';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const entry of entries) {
    const listName = listNameMap.get(entry.list_id) ?? `List #${entry.list_id}`;
    const createdAt = new Date(entry.created_at)
      .toISOString()
      .replace('T', ' ')
      .replace(/\.\d+Z$/, ' UTC');
    console.log(listName.padEnd(40) + String(entry.id).padEnd(14) + createdAt);
  }

  console.log(`\n${entries.length} list entries found.`);
  console.log(`Total API calls: ${apiCallCount}/${MAX_API_CALLS}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  API_KEY = await resolveApiKey();
  return findOrgListEntries();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
