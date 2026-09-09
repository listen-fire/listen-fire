/**
 * Affinity Relationship Strengths Script
 *
 * Lists relationship strengths between internal team members and people
 * at organisations in a specified Affinity list.
 *
 * Modes:
 *   --team       List all internal team members (use to build an allowlist)
 *   --lists      List all Affinity lists
 *   (default)    Fetch relationship strengths for a given list
 *
 * Environment variables:
 *   DATABASE_URL              - Postgres connection string (for credential lookup)
 *   ENCRYPTION_MASTER_KEY     - Base64 master key (for decrypting stored credentials)
 *   ENCRYPTION_SALT_BASE64    - Base64 salt (for HKDF key derivation)
 *   AFFINITY_CREDENTIAL_ID    - UUID of the credential row in external_service_credentials
 *   AFFINITY_LIST_ID          - The numeric ID of the list to inspect
 *   INTERNAL_IDS              - Comma-separated person IDs to include (allowlist internal team)
 *   EXCLUDE_TITLES            - Comma-separated title substrings to exclude (e.g. "assistant,coordinator,ea")
 *   MAX_API_CALLS             - Hard cap on total Affinity API calls (default: 20)
 *   MAX_ORGS                  - Max orgs to process from the list (default: 5)
 *
 *   Alternatively, skip DB lookup by providing the key directly:
 *   AFFINITY_API_KEY          - Your Affinity API key (overrides DB lookup)
 *
 * Usage:
 *   # List your internal team (pick IDs for the allowlist):
 *   npx tsx affinity-relationship-strengths.ts --team
 *
 *   # List available lists:
 *   npx tsx affinity-relationship-strengths.ts --lists
 *
 *   # Fetch strengths, filtered to specific partners:
 *   AFFINITY_LIST_ID=123 INTERNAL_IDS=111,222,333 EXCLUDE_TITLES="assistant,ea,coordinator" \
 *     npx tsx affinity-relationship-strengths.ts
 */

import { hkdf, createDecipheriv } from 'node:crypto';

const LIST_ID = process.env.AFFINITY_LIST_ID;
const BASE_URL = 'https://api.affinity.co';
const MODE = process.argv[2]; // --team, --lists, or absent

const INTERNAL_ALLOWLIST = process.env.INTERNAL_IDS
  ? new Set(process.env.INTERNAL_IDS.split(',').map((s) => Number(s.trim())))
  : null;

const EXCLUDE_TITLE_PATTERNS = process.env.EXCLUDE_TITLES
  ? process.env.EXCLUDE_TITLES.split(',').map((s) => s.trim().toLowerCase())
  : [];

const MAX_API_CALLS = Number(process.env.MAX_API_CALLS) || 20;
const MAX_ORGS = Number(process.env.MAX_ORGS) || 5;

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

async function decryptToken(data: Buffer, context: string, masterKey: Buffer, salt: Buffer): Promise<string> {
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
    throw new Error(`API call limit reached (${MAX_API_CALLS}/${MAX_API_CALLS}). Increase MAX_API_CALLS to fetch more.`);
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
}

interface Organization {
  id: number;
  name: string | null;
  domain: string | null;
  person_ids: number[] | null;
}

interface Person {
  id: number;
  type: number; // 0 = external, 1 = internal
  first_name: string | null;
  last_name: string | null;
  primary_email: string | null;
}

interface FieldValue {
  id: number;
  field_id: number;
  entity_id: number;
  value: unknown;
}

interface FieldDef {
  id: number;
  name: string;
  value_type: number;
  enrichment_source?: string;
}

interface RelationshipStrength {
  internal_id: number;
  external_id: number;
  strength: number;
}

// ── Person cache (avoids duplicate fetches) ─────────────────────────────────

const personCache = new Map<number, Person>();
const personTitles = new Map<number, string>();

async function resolvePerson(id: number): Promise<Person> {
  if (personCache.has(id)) return personCache.get(id)!;
  const person = await affinityGet<Person>(`/persons/${id}`);
  personCache.set(id, person);
  return person;
}

function personName(id: number): string {
  const p = personCache.get(id);
  if (!p) return `#${id}`;
  return [p.first_name, p.last_name].filter(Boolean).join(' ') || `#${id}`;
}

// ── Title resolution ────────────────────────────────────────────────────────

let titleFieldId: number | null = null;

async function discoverTitleFieldId(): Promise<void> {
  // Person fields are fetched from /persons/fields
  const fields = await affinityGet<FieldDef[]>('/persons/fields');
  const titleField = fields.find(
    (f) => /\b(title|job.?title|role|position)\b/i.test(f.name),
  );
  if (titleField) {
    titleFieldId = titleField.id;
    console.error(`  Found title field: "${titleField.name}" (id=${titleField.id})`);
  } else {
    console.error('  No title/role field found on persons. Available fields:');
    for (const f of fields) console.error(`    ${f.id}\t${f.name}`);
  }
}

async function resolveTitle(personId: number): Promise<string | null> {
  if (titleFieldId === null) return null;
  if (personTitles.has(personId)) return personTitles.get(personId) ?? null;

  const values = await affinityGet<FieldValue[]>('/field-values', {
    person_id: String(personId),
    field_id: String(titleFieldId),
  });

  const title = values.length > 0 && typeof values[0].value === 'string' ? values[0].value : null;
  personTitles.set(personId, title ?? '');
  return title;
}

function isTitleExcluded(title: string | null): boolean {
  if (!title || EXCLUDE_TITLE_PATTERNS.length === 0) return false;
  const lower = title.toLowerCase();
  return EXCLUDE_TITLE_PATTERNS.some((pat) => lower.includes(pat));
}

// ── Modes ───────────────────────────────────────────────────────────────────

async function listTeam() {
  console.error('\nFetching internal team members (type=1)...\n');

  // Paginate through all persons, filter to type=1
  const persons = await paginateAll<Person>('/persons', 'persons');
  const internal = persons.filter((p) => p.type === 1);

  console.log('ID'.padEnd(12) + 'Name'.padEnd(30) + 'Email');
  console.log('-'.repeat(72));

  for (const p of internal) {
    personCache.set(p.id, p);
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ');
    console.log(
      String(p.id).padEnd(12) +
        name.padEnd(30) +
        (p.primary_email ?? ''),
    );
  }

  console.log(`\n${internal.length} internal team members. Use INTERNAL_IDS=${internal.map((p) => p.id).join(',')} to allowlist.`);
}

async function listLists() {
  const lists = await affinityGet<AffinityList[]>('/lists');
  console.log('ID'.padEnd(12) + 'Name'.padEnd(40) + 'Entries');
  console.log('-'.repeat(60));
  for (const list of lists) {
    console.log(String(list.id).padEnd(12) + list.name.padEnd(40) + String(list.list_size));
  }
}

async function fetchStrengths() {
  if (!LIST_ID) {
    console.error('Missing AFFINITY_LIST_ID. Run with --lists to see available lists.');
    process.exit(1);
  }

  // 1. Discover title field (1 call)
  if (EXCLUDE_TITLE_PATTERNS.length > 0) {
    await discoverTitleFieldId();
  }

  // 2. Get ALL list entries (paginated, usually 1-2 calls)
  console.error(`\nFetching all entries from list ${LIST_ID}...`);
  const entries = await paginateAll<ListEntry>(`/lists/${LIST_ID}/list-entries`, 'list_entries');
  console.error(`Got ${entries.length} list entries.`);

  // 3. Fetch each org to get person_ids (capped by MAX_ORGS)
  const entriesToProcess = entries.slice(0, MAX_ORGS);
  if (entries.length > MAX_ORGS) {
    console.error(`Processing ${MAX_ORGS} of ${entries.length} orgs (set MAX_ORGS to increase).`);
  }

  const orgPeople: { orgId: number; orgName: string; personIds: number[] }[] = [];
  for (const entry of entriesToProcess) {
    if (remainingCalls() <= 1) {
      console.error('Approaching API limit, stopping org fetches.');
      break;
    }
    const org = await affinityGet<Organization>(`/organizations/${entry.entity_id}`);
    if (org.person_ids?.length) {
      orgPeople.push({
        orgId: org.id,
        orgName: org.name ?? `Org #${org.id}`,
        personIds: org.person_ids,
      });
    }
  }

  const allExternalPersonIds = [...new Set(orgPeople.flatMap((o) => o.personIds))];
  console.error(`Found ${allExternalPersonIds.length} unique people across ${orgPeople.length} orgs.`);

  // 4. Build person→org lookup
  const personToOrg = new Map<number, string>();
  for (const op of orgPeople) {
    for (const pid of op.personIds) {
      personToOrg.set(pid, op.orgName);
    }
  }

  // 5. Fetch relationship strengths per org (1 call per org instead of 1 per person)
  //    Try organization_id first; fall back to per-person if that fails
  const strengths: RelationshipStrength[] = [];
  let perOrgWorks = true;

  for (const op of orgPeople) {
    if (remainingCalls() <= 0) {
      console.error('API limit reached, stopping strength fetches.');
      break;
    }

    if (perOrgWorks) {
      try {
        const result = await affinityGet<RelationshipStrength[]>(
          '/relationships-strengths',
          { organization_id: String(op.orgId) },
        );
        strengths.push(...result);
        continue;
      } catch {
        console.error('  organization_id param not supported, falling back to per-person.');
        perOrgWorks = false;
      }
    }

    // Per-person fallback
    for (const personId of op.personIds) {
      if (remainingCalls() <= 0) {
        console.error('API limit reached, stopping per-person strength fetches.');
        break;
      }
      try {
        const result = await affinityGet<RelationshipStrength[]>(
          '/relationships-strengths',
          { external_id: String(personId) },
        );
        strengths.push(...result);
      } catch {
        if (remainingCalls() <= 0) break;
        // Try person_id param name
        try {
          const result = await affinityGet<RelationshipStrength[]>(
            '/relationships-strengths',
            { person_id: String(personId) },
          );
          strengths.push(...result);
        } catch {
          console.error(`  Could not fetch strengths for person ${personId}`);
        }
      }
    }
  }

  // Deduplicate strengths (same pair may appear from overlapping queries)
  const seen = new Set<string>();
  const dedupedStrengths = strengths.filter((s) => {
    const key = `${s.internal_id}:${s.external_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  console.error(`Got ${dedupedStrengths.length} unique relationship strengths.`);

  // 6. Apply internal allowlist filter
  const filtered = INTERNAL_ALLOWLIST
    ? dedupedStrengths.filter((s) => INTERNAL_ALLOWLIST.has(s.internal_id))
    : dedupedStrengths;

  if (INTERNAL_ALLOWLIST) {
    console.error(`After internal allowlist: ${filtered.length} strengths.`);
  }

  // 7. Resolve all person names (batch: collect unique IDs, fetch once each)
  const allPersonIds = [...new Set(filtered.flatMap((s) => [s.internal_id, s.external_id]))];
  console.error(`\nResolving ${allPersonIds.length} person names (${remainingCalls()} calls left)...`);

  for (const id of allPersonIds) {
    if (remainingCalls() <= 0) {
      console.error('API limit reached, remaining people will show as IDs.');
      break;
    }
    try {
      await resolvePerson(id);
    } catch {
      // Will show as #id
    }
  }

  // 8. Resolve titles and filter excluded titles
  let titleFiltered = filtered;
  if (EXCLUDE_TITLE_PATTERNS.length > 0 && titleFieldId !== null) {
    console.error(`\nResolving titles to filter by: ${EXCLUDE_TITLE_PATTERNS.join(', ')}...`);

    const externalIds = [...new Set(filtered.map((s) => s.external_id))];
    for (const id of externalIds) {
      if (remainingCalls() <= 0) {
        console.error('API limit reached, skipping remaining title lookups.');
        break;
      }
      await resolveTitle(id);
    }

    titleFiltered = filtered.filter((s) => {
      const title = personTitles.get(s.external_id) ?? null;
      return !isTitleExcluded(title);
    });

    console.error(`After title filter: ${titleFiltered.length} strengths (removed ${filtered.length - titleFiltered.length}).`);
  }

  // 9. Output
  titleFiltered.sort((a, b) => b.strength - a.strength);

  const showTitle = titleFieldId !== null;
  const header =
    'Internal'.padEnd(28) +
    'External'.padEnd(28) +
    'Organisation'.padEnd(28) +
    (showTitle ? 'Title'.padEnd(28) : '') +
    'Strength';

  console.log('\n=== Relationship Strengths ===\n');

  if (!titleFiltered.length) {
    console.log('No relationship strength data after filtering.');
    console.log(`\nTotal API calls: ${apiCallCount}/${MAX_API_CALLS}`);
    return;
  }

  console.log(header);
  console.log('-'.repeat(header.length));

  for (const s of titleFiltered) {
    const line =
      personName(s.internal_id).padEnd(28) +
      personName(s.external_id).padEnd(28) +
      (personToOrg.get(s.external_id) ?? 'Unknown').padEnd(28) +
      (showTitle ? (personTitles.get(s.external_id) ?? '').padEnd(28) : '') +
      s.strength.toFixed(2);
    console.log(line);
  }

  console.log(`\nTotal API calls: ${apiCallCount}/${MAX_API_CALLS}`);
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  API_KEY = await resolveApiKey();

  if (MODE === '--team') return listTeam();
  if (MODE === '--lists') return listLists();
  return fetchStrengths();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
