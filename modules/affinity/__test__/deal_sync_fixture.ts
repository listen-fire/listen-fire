// A deal sync, as the engine drives this adapter for one deal, over a fake
// Affinity that answers on the wire and logs every request.
//
// The deal is Project A's `Upsert Deal`: write the organization (Name, Domain
// set-if-empty), look the company up on the Master Deals List by name and by
// domain, write its list entry (every field set-if-empty), match each owner by
// email and link them onto the entry, then write each founder onto the
// organization's `Founders` field and attach them to its People.
//
// The engine is not in this process, so its calls are made here in the order
// `write.rs` and `verbs.rs` make them: a write is `resolveEntity`, then
// `readRecord` and an `updateRecord` (only when something changed or the write
// hangs off a parent), or a `createRecord`; a `match` is `resolveEntity` then
// `readRecord`; a `link` is `linkRecords`. The no-op decision is the engine's
// own rule, restated: a `?:` field is written only into an empty slot, a plain
// one only when it differs.

import type { ModuleModels } from 'module-kit';
import type { Expression } from 'engine-contracts/expression/expression';
import type { ResolveEntityInput } from 'movement-engine/public/adapter';

import { AffinityAdapter } from '../adapter';
import { AffinityAPIClient } from '../api_client';

export const LIST_ID = 10;
export const LIST_NAME = 'Master Deals List';
const ENTRY_TYPE = `List Entry — ${LIST_NAME}`;

const FIELD = {
  founders: 300,
  status: 310,
  dealSource: 311,
  owners: 312,
  dealCreated: 313,
  stageOrder: 314,
  deepDive: 315,
  diverse: 316,
  sourcing: 317,
  linkedin: 320,
} as const;

/** What a synced entry already holds for the fields `Upsert Deal` fills. */
export const SYNCED_ENTRY = {
  stage: 'IM Review / More Research Before Outreach',
  status: 'Current Dealflow',
  source: 'Quality Dealflow',
  deepDive: 'AI Agents',
  diverse: 'No',
} as const;

const field = (
  id: number,
  name: string,
  entityType: 0 | 1,
  valueType: number,
  options: { listId?: number; multiple?: boolean } = {},
) => ({
  id,
  name,
  entity_type: entityType,
  value_type: valueType,
  list_id: options.listId ?? null,
  enrichment_source: 'none',
  allows_multiple: options.multiple ?? false,
  track_changes: false,
  dropdown_options: null,
});

const FIELDS = [
  field(FIELD.founders, 'Founders', 1, 0, { multiple: true }),
  field(FIELD.status, `[${LIST_NAME}] Status`, 1, 6, { listId: LIST_ID }),
  field(FIELD.dealSource, `[${LIST_NAME}] Deal Source`, 1, 6, { listId: LIST_ID }),
  field(FIELD.owners, `[${LIST_NAME}] Owners`, 1, 0, { listId: LIST_ID, multiple: true }),
  field(FIELD.dealCreated, `[${LIST_NAME}] Deal Created`, 1, 4, { listId: LIST_ID }),
  field(FIELD.stageOrder, `[${LIST_NAME}] Stage Order`, 1, 6, { listId: LIST_ID }),
  field(FIELD.deepDive, `[${LIST_NAME}] Deep Dive`, 1, 6, { listId: LIST_ID }),
  field(FIELD.diverse, `[${LIST_NAME}] At least one ethincally diverse founder`, 1, 6, { listId: LIST_ID }),
  field(FIELD.sourcing, `[${LIST_NAME}] Sourcing/Intro IM`, 1, 6, { listId: LIST_ID }),
  field(FIELD.linkedin, 'LinkedIn URL', 0, 6),
];

interface Org {
  id: number;
  name: string;
  domain: string | null;
  global: boolean;
  person_ids: number[];
}
interface Person {
  id: number;
  first_name: string;
  last_name: string;
  primary_email: string | null;
  emails: string[];
  organization_ids: number[];
}
interface Entry {
  id: number;
  list_id: number;
  entity_id: number;
  created_at: string;
}
interface ValueRow {
  id: number;
  field_id: number;
  entity_id: number;
  entity_type: 0 | 1;
  list_entry_id: number | null;
  value: unknown;
}

/** One Affinity workspace, mutable: what a write sends lands here, so a later
 *  read answers with it — the property a stale cache would break. */
export class FakeAffinity {
  orgs = new Map<number, Org>();
  persons = new Map<number, Person>();
  entries = new Map<number, Entry>();
  values = new Map<number, ValueRow>();
  /** Every request on the wire, `METHOD /path?query`. */
  requests: string[] = [];
  private nextId = 5000;

  /** How many search results Affinity puts on a page when the request names
   *  no `page_size` — its documented default and cap. */
  static readonly DEFAULT_PAGE = 500;

  id(): number {
    return (this.nextId += 1);
  }

  org(input: { name: string; domain?: string | null; global?: boolean }): Org {
    const org: Org = { id: this.id(), name: input.name, domain: input.domain ?? null, global: input.global ?? false, person_ids: [] };
    this.orgs.set(org.id, org);
    return org;
  }

  person(input: { first: string; last: string; email?: string; orgIds?: number[] }): Person {
    const person: Person = {
      id: this.id(),
      first_name: input.first,
      last_name: input.last,
      primary_email: input.email ?? null,
      emails: input.email ? [input.email] : [],
      organization_ids: input.orgIds ?? [],
    };
    this.persons.set(person.id, person);
    for (const orgId of person.organization_ids) this.orgs.get(orgId)?.person_ids.push(person.id);
    return person;
  }

  entry(orgId: number): Entry {
    const entry: Entry = { id: this.id(), list_id: LIST_ID, entity_id: orgId, created_at: '2026-01-05T00:00:00.000Z' };
    this.entries.set(entry.id, entry);
    return entry;
  }

  value(input: { fieldId: number; entityId: number; entityType: 0 | 1; listEntryId?: number; value: unknown }): ValueRow {
    const row: ValueRow = {
      id: this.id(),
      field_id: input.fieldId,
      entity_id: input.entityId,
      entity_type: input.entityType,
      list_entry_id: input.listEntryId ?? null,
      value: input.value,
    };
    this.values.set(row.id, row);
    return row;
  }

  private orgBody(org: Org) {
    return {
      ...org,
      domains: org.domain ? [org.domain] : [],
      list_entries: [...this.entries.values()].filter((e) => e.entity_id === org.id),
    };
  }

  private personBody(person: Person) {
    return { ...person, list_entries: [] };
  }

  private rowBody(row: ValueRow) {
    const fieldDef = FIELDS.find((f) => f.id === row.field_id);
    return { ...row, value_type: fieldDef?.value_type ?? 6 };
  }

  /** `term` is a case-insensitive substring of a name, a domain or an address,
   *  as Affinity's search is; pages come `page_size` at a time. */
  private page<T>(all: T[], url: URL, key: string) {
    const size = Number(url.searchParams.get('page_size') ?? FakeAffinity.DEFAULT_PAGE);
    const start = Number(url.searchParams.get('page_token') ?? 0);
    const slice = all.slice(start, start + size);
    const next = start + size < all.length ? String(start + size) : null;
    return { [key]: slice, next_page_token: next };
  }

  install(): void {
    global.fetch = (async (input: URL | string, init?: { method?: string; body?: string }) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      this.requests.push(`${method} ${url.pathname}${url.search}`);
      const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {};
      const json = (payload: unknown, status = 200) =>
        new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
      const path = url.pathname;
      let m: RegExpMatchArray | null;

      if (path === '/auth/whoami') {
        return json({
          tenant: { id: 1, name: 'Project A', subdomain: 'projecta' },
          user: { id: 1, firstName: 'A', lastName: 'B', email: 'a@b.co' },
          grant: { type: 't', scope: 's', createdAt: '' },
        });
      }
      if (path === '/fields') {
        const entityType = url.searchParams.get('entity_type');
        return json(FIELDS.filter((f) => entityType === null || String(f.entity_type) === entityType));
      }
      if (path === '/lists') return json([{ id: LIST_ID, name: LIST_NAME, type: 1 }]);
      if ((m = path.match(/^\/lists\/(\d+)$/))) return json({ id: Number(m[1]), name: LIST_NAME, type: 1 });

      if (path === '/organizations' && method === 'GET') {
        const term = (url.searchParams.get('term') ?? '').toLowerCase();
        const hits = [...this.orgs.values()]
          .filter((o) => o.name.toLowerCase().includes(term) || (o.domain ?? '').toLowerCase().includes(term))
          .map((o) => this.orgBody(o));
        return json(this.page(hits, url, 'organizations'));
      }
      if (path === '/organizations' && method === 'POST') {
        const org = this.org({ name: String(body.name), domain: (body.domain as string | null) ?? null });
        return json(this.orgBody(org));
      }
      if ((m = path.match(/^\/organizations\/(\d+)$/))) {
        const org = this.orgs.get(Number(m[1]));
        if (!org) return json({ message: 'not found' }, 404);
        if (method === 'PUT') Object.assign(org, body);
        return json(this.orgBody(org));
      }

      if (path === '/persons' && method === 'GET') {
        const term = (url.searchParams.get('term') ?? '').toLowerCase();
        const hits = [...this.persons.values()]
          .filter(
            (p) =>
              `${p.first_name} ${p.last_name}`.toLowerCase().includes(term) ||
              p.emails.some((e) => e.toLowerCase().includes(term)),
          )
          .map((p) => this.personBody(p));
        return json(this.page(hits, url, 'persons'));
      }
      if (path === '/persons' && method === 'POST') {
        const person = this.person({
          first: String(body.first_name),
          last: String(body.last_name),
          email: (body.emails as string[] | undefined)?.[0],
          orgIds: (body.organization_ids as number[] | undefined) ?? [],
        });
        return json(this.personBody(person));
      }
      if ((m = path.match(/^\/persons\/(\d+)$/))) {
        const person = this.persons.get(Number(m[1]));
        if (!person) return json({ message: 'not found' }, 404);
        if (method === 'PUT') Object.assign(person, body);
        return json(this.personBody(person));
      }

      if ((m = path.match(/^\/lists\/(\d+)\/list-entries$/)) && method === 'POST') {
        const entry = this.entry(Number(body.entity_id));
        return json(entry);
      }
      if ((m = path.match(/^\/lists\/(\d+)\/list-entries\/(\d+)$/))) {
        const entry = this.entries.get(Number(m[2]));
        if (!entry) return json({ message: 'not found' }, 404);
        return json(entry);
      }

      if (path === '/field-values' && method === 'GET') {
        const orgId = url.searchParams.get('organization_id');
        const personId = url.searchParams.get('person_id');
        const entryId = url.searchParams.get('list_entry_id');
        const rows = [...this.values.values()].filter((r) =>
          entryId !== null
            ? r.list_entry_id === Number(entryId)
            : orgId !== null
              ? r.entity_type === 1 && r.entity_id === Number(orgId)
              : personId !== null
                ? r.entity_type === 0 && r.entity_id === Number(personId)
                : true,
        );
        return json(rows.map((r) => this.rowBody(r)));
      }
      if (path === '/field-values' && method === 'POST') {
        const fieldDef = FIELDS.find((f) => f.id === body.field_id);
        const row = this.value({
          fieldId: Number(body.field_id),
          entityId: Number(body.entity_id),
          entityType: fieldDef?.entity_type ?? 1,
          listEntryId: body.list_entry_id === undefined ? undefined : Number(body.list_entry_id),
          value: body.value,
        });
        return json(this.rowBody(row));
      }
      if ((m = path.match(/^\/field-values\/(\d+)$/))) {
        const row = this.values.get(Number(m[1]));
        if (!row) return json({ message: 'not found' }, 404);
        if (method === 'PUT') row.value = body.value;
        if (method === 'DELETE') this.values.delete(row.id);
        return json(this.rowBody(row));
      }

      return json({ message: `unhandled ${method} ${path}` }, 404);
    }) as unknown as typeof fetch;
  }
}

/** What a run's requests were spent on. */
export interface CallCounts {
  orgSearch: number;
  personSearch: number;
  fieldValueRead: number;
  recordRead: number;
  schema: number;
  write: number;
  total: number;
}

export function countCalls(requests: readonly string[]): CallCounts {
  const counts: CallCounts = { orgSearch: 0, personSearch: 0, fieldValueRead: 0, recordRead: 0, schema: 0, write: 0, total: 0 };
  for (const request of requests) {
    const [method, target] = request.split(' ');
    const path = target.split('?')[0];
    counts.total += 1;
    if (method !== 'GET') counts.write += 1;
    else if (path === '/organizations') counts.orgSearch += 1;
    else if (path === '/persons') counts.personSearch += 1;
    else if (path === '/field-values') counts.fieldValueRead += 1;
    else if (path === '/fields' || path === '/lists' || path === '/auth/whoami') counts.schema += 1;
    else counts.recordRead += 1;
  }
  return counts;
}

/** The models the matcher consults: affixes come off nothing, a split is the
 *  last token, and every judge declines — so a match here is a rule's, never a
 *  model's. */
export const plainModels: ModuleModels = {
  chat: async (input) => {
    if (input.label === 'affinity.stripNameAffixes') return JSON.stringify({ name: input.userMessage });
    if (input.label === 'affinity.splitName') {
      const tokens = input.userMessage.trim().split(/\s+/);
      return JSON.stringify({ first_name: tokens.slice(0, -1).join(' '), last_name: tokens[tokens.length - 1] });
    }
    return 'null';
  },
  chatStructured: async <T,>(input: { schema: { parse(value: unknown): T } }) => input.schema.parse({ id: null }),
};

let tenants = 0;

/** The real adapter, client and operations over the fake. Each one is its own
 *  tenant and credential, so no catalog or schema cache leaks between tests. */
export function adapterOver(fake: FakeAffinity): AffinityAdapter {
  tenants += 1;
  const client = new AffinityAPIClient({ apiKey: `key-${tenants}`, baseUrl: 'https://affinity.test' });
  return new AffinityAdapter({
    tenant: `team-deal-sync-${tenants}`,
    client: async () => client,
    models: plainModels,
    files: {
      put: async () => {
        throw new Error('no files in a deal sync');
      },
      read: async () => {
        throw new Error('no files in a deal sync');
      },
      expose: async () => {
        throw new Error('no files in a deal sync');
      },
    },
    fetch,
  });
}

// ── The engine's half ───────────────────────────────────────────────────────

const MUTATION = {} as never;
const NO_CONSTRAINTS = { any: [] } as unknown as ResolveEntityInput['constraints'];
const META = { adapterType: 'affinity', recordType: 'meta', identity: { kind: 'unstable' as const, data: undefined } };

const eq = (field: string, value: string): Expression => ({
  type: 'compare',
  op: 'eq',
  left: { type: 'edge_property', propertyTypeId: field },
  right: { type: 'static', value },
});

const isEmpty = (value: unknown) =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

/** `merge_into_record`'s no-op rule over what `readRecord` answered. */
function toWrite(
  current: Record<string, unknown> | null,
  fields: Record<string, unknown>,
  fill: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    const now = current?.[key];
    if (fill.has(key)) {
      if (isEmpty(now)) out[key] = value;
    } else if (current === null || JSON.stringify(now) !== JSON.stringify(value)) {
      out[key] = value;
    }
  }
  return out;
}

export interface Deal {
  name: string;
  host: string;
  status: string;
  source: string;
  owners: string[];
  founders: { first: string; last: string; linkedin: string }[];
}

/** A plainly set field's change-log line: what the write found, then what it
 *  asked for. Empty when they agree. */
export function changeLine(label: string, was: unknown, now: string): string {
  const old = isEmpty(was) ? '∅' : String(was);
  return old === now || now === '' ? '' : `${label}: \`${old}\` → \`${now}\``;
}

/** One field line of the deal's change log, as `Upsert Deal` renders it from
 *  the record the write found: a set-if-empty field that landed in an empty
 *  slot. Empty when nothing changed. */
export function fillLine(label: string, was: unknown, asked: string): string {
  const old = isEmpty(was) ? '∅' : String(was);
  return asked === '' || old !== '∅' ? '' : `${label}: ∅ → \`${asked}\``;
}

export interface DealOutcome {
  orgId: string;
  entryId: string;
  /** What each write found, keyed by record — the `@old` a change log reads. */
  found: { org: Record<string, unknown> | null; entry: Record<string, unknown> | null; founders: (Record<string, unknown> | null)[] };
  /** The change log's field lines, rendered from `found` the way the movement does. */
  changes: string[];
}

/** Write one deal the way the engine runs `Upsert Deal` against this adapter. */
export async function upsertDeal(adapter: AffinityAdapter, deal: Deal): Promise<DealOutcome> {
  const changes: string[] = [];

  // org = write crm-[:Organization]-> { Name: d.name, Domain ?: host }
  const orgFields = { Name: deal.name, Domain: deal.host };
  const orgMatch = await adapter.resolveEntity({ recordType: 'Organization', record: orgFields, candidates: [], constraints: NO_CONSTRAINTS });
  let orgId: string;
  let orgFound: Record<string, unknown> | null = null;
  if (orgMatch.candidates[0]) {
    orgId = orgMatch.candidates[0].externalId;
    orgFound = await adapter.readRecord({ recordType: 'Organization', externalId: orgId, fieldIds: Object.keys(orgFields) });
    const fields = toWrite(orgFound, orgFields, new Set(['Domain']));
    if (Object.keys(fields).length > 0) {
      await adapter.updateRecord({ recordType: 'Organization', externalId: orgId, fields, parentLinks: [], mutationContext: MUTATION });
    }
    changes.push(changeLine('Name', orgFound?.Name, deal.name), fillLine('Domain', orgFound?.Domain, deal.host));
  } else {
    orgId = (await adapter.createRecord({ recordType: 'Organization', fields: orgFields, parentLinks: [], mutationContext: MUTATION })).externalId;
  }

  // by_name / by_dom: crm-[o:Organization WHERE …]->-[le:`List Entries` WHERE le.listName == …]-> { le.`Deal Created` }
  for (const where of [eq('Name', deal.name), eq('Domain', deal.host)]) {
    const orgs = await adapter.getRelated({ position: META, fieldId: 'Organization', direction: 'outgoing', where });
    for (const org of orgs) {
      const entries = await adapter.getRelated({
        position: org.position,
        fieldId: 'List Entries',
        direction: 'outgoing',
        where: eq('listName', LIST_NAME),
      });
      for (const entry of entries) {
        const data = (entry.position as { identity: { data?: Record<string, unknown> } }).identity.data;
        if (data?.listName !== LIST_NAME) continue;
        await adapter.getFieldValue({ position: entry.position, fieldId: 'Deal Created' });
      }
    }
  }

  // entry = write org-[:`List Entries`]-> { listName: …, Status ?: …, `Deal Source` ?: … }
  // Every field the movement sets on the entry, each set-if-empty. Sourcing and
  // Deal Created are left out: a live sync asks for neither (empty and null),
  // and an empty value is never sent.
  const entryFields = {
    listName: LIST_NAME,
    'Stage Order': SYNCED_ENTRY.stage,
    Status: deal.status,
    'Deal Source': deal.source,
    'Deep Dive': SYNCED_ENTRY.deepDive,
    'At least one ethincally diverse founder': SYNCED_ENTRY.diverse,
  };
  const parentLinks = [{ recordType: 'Organization', externalId: orgId, edgeName: 'List Entries' }];
  const entryMatch = await adapter.resolveEntity({
    recordType: 'Organization List Entry',
    record: { ...entryFields, 'List Entries': { id: orgId } },
    candidates: [],
    constraints: NO_CONSTRAINTS,
  });
  let entryId: string;
  let entryFound: Record<string, unknown> | null = null;
  if (entryMatch.candidates[0]) {
    entryId = entryMatch.candidates[0].externalId;
    entryFound = await adapter.readRecord({ recordType: 'Organization List Entry', externalId: entryId, fieldIds: Object.keys(entryFields) });
    const fields = toWrite(entryFound, entryFields, new Set(Object.keys(entryFields).filter((key) => key !== 'listName')));
    await adapter.updateRecord({ recordType: 'Organization List Entry', externalId: entryId, fields, parentLinks, mutationContext: MUTATION });
    changes.push(fillLine('Status', entryFound?.Status, deal.status), fillLine('Deal Source', entryFound?.['Deal Source'], deal.source));
  } else {
    entryId = (await adapter.createRecord({ recordType: 'Organization List Entry', fields: entryFields, parentLinks, mutationContext: MUTATION })).externalId;
  }

  // owner = match crm-[:Person]-> { Email: m.email }; link entry -[:Owners]-> owner
  for (const email of deal.owners) {
    const owner = await adapter.resolveEntity({ recordType: 'Person', record: { Email: email }, candidates: [], constraints: NO_CONSTRAINTS });
    const candidate = owner.candidates[0];
    if (!candidate) continue;
    await adapter.readRecord({ recordType: 'Person', externalId: candidate.externalId });
    await adapter.linkRecords({
      from: { recordType: ENTRY_TYPE, externalId: entryId },
      edgeName: 'Owners',
      to: { recordType: 'Person', externalId: candidate.externalId },
      mutationContext: MUTATION,
    });
  }

  // person = write org-[:Founders]-> { First name ?:, Last name ?:, LinkedIn URL ?: }; link org -[:People]-> person
  const foundersFound: (Record<string, unknown> | null)[] = [];
  for (const founder of deal.founders) {
    const fields = { 'First name': founder.first, 'Last name': founder.last, 'LinkedIn URL': founder.linkedin };
    const links = [{ recordType: 'Organization', externalId: orgId, edgeName: 'Founders' }];
    const match = await adapter.resolveEntity({ recordType: 'Person', record: fields, candidates: [], constraints: NO_CONSTRAINTS });
    let personId: string;
    if (match.candidates[0]) {
      personId = match.candidates[0].externalId;
      const found = await adapter.readRecord({ recordType: 'Person', externalId: personId, fieldIds: Object.keys(fields) });
      foundersFound.push(found);
      const write = toWrite(found, fields, new Set(Object.keys(fields)));
      await adapter.updateRecord({ recordType: 'Person', externalId: personId, fields: write, parentLinks: links, mutationContext: MUTATION });
      changes.push(fillLine('LinkedIn URL', found?.['LinkedIn URL'], founder.linkedin));
    } else {
      foundersFound.push(null);
      personId = (await adapter.createRecord({ recordType: 'Person', fields, parentLinks: links, mutationContext: MUTATION })).externalId;
    }
    await adapter.linkRecords({
      from: { recordType: 'Organization', externalId: orgId },
      edgeName: 'People',
      to: { recordType: 'Person', externalId: personId },
      mutationContext: MUTATION,
    });
  }

  return {
    orgId,
    entryId,
    found: { org: orgFound, entry: entryFound, founders: foundersFound },
    changes: changes.filter((line) => line !== ''),
  };
}

// ── The workspace a recap meets ─────────────────────────────────────────────

export const OWNERS = ['daria@project-a.vc', 'oskar@project-a.vc'];

/** A team of owners, and a company already synced: its organization, its
 *  founder (employed there, on `Founders`), its Master Deals entry with every
 *  field the deal sets already filled and both owners linked. */
export function seedWorkspace(fake: FakeAffinity, ownerEmails: readonly string[] = OWNERS) {
  const owners = ownerEmails.map((email, i) => fake.person({ first: `Owner${i}`, last: 'Team', email }));
  // Affinity's global dataset shares the name; the judge never adopts it here.
  fake.org({ name: 'Veltha Global Holdings', domain: 'veltha-holdings.example', global: true });
  return { owners };
}

export function seedSyncedDeal(
  fake: FakeAffinity,
  owners: Person[],
  input: { name: string; host: string; founder: { first: string; last: string; linkedin: string }; founders?: { first: string; last: string; linkedin: string }[] },
  options: { emptyDealSource?: boolean; orgName?: string } = {},
) {
  const org = fake.org({ name: options.orgName ?? input.name, domain: input.host || null });
  const people = (input.founders ?? [input.founder]).map((f) => {
    const person = fake.person({ first: f.first, last: f.last, orgIds: [org.id] });
    fake.value({ fieldId: FIELD.founders, entityId: org.id, entityType: 1, value: person.id });
    fake.value({ fieldId: FIELD.linkedin, entityId: person.id, entityType: 0, value: f.linkedin });
    return person;
  });
  const founder = people[0];
  const entry = fake.entry(org.id);
  const onEntry = (fieldId: number, value: unknown) =>
    fake.value({ fieldId, entityId: org.id, entityType: 1, listEntryId: entry.id, value });
  onEntry(FIELD.stageOrder, SYNCED_ENTRY.stage);
  onEntry(FIELD.status, SYNCED_ENTRY.status);
  if (!options.emptyDealSource) onEntry(FIELD.dealSource, SYNCED_ENTRY.source);
  onEntry(FIELD.deepDive, SYNCED_ENTRY.deepDive);
  onEntry(FIELD.diverse, SYNCED_ENTRY.diverse);
  for (const owner of owners) {
    fake.value({ fieldId: FIELD.owners, entityId: org.id, entityType: 1, listEntryId: entry.id, value: owner.id });
  }
  return { org, founder, entry };
}

export function dealFor(input: { name: string; host: string; founder: { first: string; last: string; linkedin: string } }): Deal {
  return {
    name: input.name,
    host: input.host,
    status: 'Current Dealflow',
    source: 'Quality Dealflow',
    owners: OWNERS,
    founders: [input.founder],
  };
}
