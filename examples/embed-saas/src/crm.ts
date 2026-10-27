// The SaaS's own product, as the module its customers' movements reach: a
// tiny CRM with one record type, `Company`, and one event a listen may
// choose, `company.created`. Each customer defines its own fields on
// `Company` (a text field, or a select with its own options), so the schema
// the module describes is that customer's. The records and the field
// definitions live in the SaaS's own store (`CompanyStore`), one tenant's
// apart from another's; the module only answers the adapter protocol over
// them.

import type { Adapter, AdapterManifest, DiscriminableEvent, GetRelatedInput, ResolveEntityInput } from '@listen-fire/engine/public/adapter';
import { BASE_RUNTIME_CAPABILITIES, containerAssociation } from '@listen-fire/engine/public/adapter';
import { makeStablePosition } from '@listen-fire/engine/public/catalog';
import { defineModule, type AdapterModuleMethods, type ModuleContext } from '@listen-fire/module-kit';

export const COMPANY = 'Company';
export const COMPANY_CREATED = 'company.created';

/** A company: its id, and the values of the fields its customer defined. */
export type Company = { id: string } & Record<string, string>;

/** A field a customer defines on `Company`. With `options` it is a select:
 *  only those values are valid. */
export interface FieldDefinition {
  name: string;
  options?: string[];
}

/** Every customer's companies have a name, whatever else they define. */
const NAME_FIELD: FieldDefinition = { name: 'Name' };

/** The SaaS's own records and field definitions, by tenant. */
export class CompanyStore {
  private readonly byTenant = new Map<string, Company[]>();
  private readonly fieldsByTenant = new Map<string, FieldDefinition[]>();

  defineFields(tenant: string, fields: FieldDefinition[]): void {
    this.fieldsByTenant.set(tenant, [NAME_FIELD, ...fields]);
  }

  fieldsOf(tenant: string): FieldDefinition[] {
    return this.fieldsByTenant.get(tenant) ?? [NAME_FIELD];
  }

  list(tenant: string): Company[] {
    return this.byTenant.get(tenant) ?? [];
  }

  add(tenant: string, fields: Record<string, string>): Company {
    const companies = this.byTenant.get(tenant) ?? [];
    const company = { id: `company-${companies.length + 1}`, ...fields };
    this.byTenant.set(tenant, [...companies, company]);
    return company;
  }

  update(tenant: string, id: string, fields: Record<string, string>): Company | undefined {
    const company = this.list(tenant).find((c) => c.id === id);
    if (company !== undefined) Object.assign(company, fields);
    return company;
  }
}

/** The event the SaaS raises when a company is created, as a listen reads it. */
export function companyCreated(company: Company): DiscriminableEvent {
  return { payload: company, externalId: company.id, tag: COMPANY_CREATED, eventType: COMPANY_CREATED, changeType: 'create', recordType: COMPANY };
}

const MANIFEST: AdapterManifest = {
  adapterType: 'crm',
  displayName: 'CRM',
  description: "The product's own CRM.",
  supportedTriggers: ['webhook'],
  methods: ['listEntryPoints', 'describe', 'resolveEntity', 'getFieldValue', 'getRelated', 'createRecord', 'updateRecord', 'listEventTypes'],
  subscribableEvents: [COMPANY_CREATED],
  declaredCredentials: ['crm'],
  introspectedSchema: true,
};

/** The company names a hop's WHERE pins (`c.Name == "Vireo"`, alone or in a
 *  conjunction), so a read fetches only those; none when it pins no name.
 *  The engine still applies the whole WHERE to what comes back. */
function pinnedName(where: GetRelatedInput['where']): string | undefined {
  if (where === undefined) return undefined;
  if (where.type === 'logical' && where.op === 'and') return where.operands.map(pinnedName).find((name) => name !== undefined);
  if (where.type !== 'compare' || where.op !== 'eq') return undefined;
  const [left, right] = [where.left, where.right];
  // A hop's WHERE reads the landed record's field as an edge property.
  const named = (side: typeof left) => (side.type === 'property' || side.type === 'edge_property') && side.propertyTypeId === NAME_FIELD.name;
  const text = (side: typeof left) => (side.type === 'static' && typeof side.value === 'string' ? side.value : undefined);
  if (named(left)) return text(right);
  if (named(right)) return text(left);
  return undefined;
}

/** Whether two values are the same identity key: text, compared without
 *  case; an empty one is no key at all. */
function sameKey(asserted: unknown, held: unknown): boolean {
  if (typeof asserted !== 'string' || typeof held !== 'string' || asserted.trim() === '' || held.trim() === '') return false;
  return asserted.toLowerCase() === held.toLowerCase();
}

/** The companies a write would update: those it is already linked to (by
 *  id), else those matching every field of some `unique by` branch. */
function existingCompanies(companies: Company[], input: ResolveEntityInput): Company[] {
  const linked = companies.filter((company) => input.candidates.some((candidate) => candidate.external_id === company.id));
  if (linked.length > 0) return linked;
  return companies.filter((company) =>
    input.constraints.any.some((branch) => branch.all.length > 0 && branch.all.every(({ field }) => sameKey(input.record[field], company[field]))),
  );
}

/** The text values among `fields`, for the customer's defined fields only. */
function definedTexts(defined: FieldDefinition[], fields: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(defined.flatMap(({ name }) => (typeof fields[name] === 'string' ? [[name, fields[name]]] : [])));
}

function crmAdapter(ctx: ModuleContext, store: CompanyStore): AdapterModuleMethods {
  const tenant = ctx.config.tenant;
  // Every call carries the customer's API key; the CRM asks that it is there.
  const authorised = async () => {
    if (!(await ctx.credential.fields()).api_key) throw new Error('crm: no API key');
  };
  const adapter: Adapter = {
    adapterType: 'crm',
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [{ typeId: COMPANY, displayName: COMPANY, writable: true, readable: true }],
    describe: async (typeId) =>
      typeId === COMPANY
        ? {
            typeId: COMPANY,
            displayName: COMPANY,
            fields: store.fieldsOf(tenant).map(({ name, options }) => ({
              fieldId: name,
              displayName: name,
              kind: options === undefined ? 'string' : 'enum',
              ...(options !== undefined ? { enumValues: options } : {}),
              writable: true,
              required: name === NAME_FIELD.name,
            })),
            references: [],
          }
        : null,
    resolveEntity: async (input) => ({
      candidates: existingCompanies(store.list(tenant), input).map((company) => ({
        adapterType: 'crm',
        externalId: company.id,
        recordType: COMPANY,
        data: { ...company },
      })),
    }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = position.identity.kind === 'stable' ? position.identity.data : undefined;
      return data !== null && typeof data === 'object' ? (Reflect.get(data, fieldId) ?? null) : null;
    },
    // The instance's `Company` edge: the customer's companies, each as the
    // record it is, so a read can find one and a write update it.
    getRelated: async ({ fieldId, direction, where }) => {
      if (direction !== 'outgoing' || fieldId !== COMPANY) return [];
      const name = pinnedName(where);
      return store
        .list(tenant)
        .filter((company) => name === undefined || company.Name === name)
        .map((company) => ({ position: makeStablePosition({ adapterType: 'crm', recordType: COMPANY, recordId: company.id, data: { ...company } }) }));
    },
    createRecord: async ({ recordType, fields }) => {
      await authorised();
      const company = store.add(tenant, { Name: '', ...definedTexts(store.fieldsOf(tenant), fields) });
      return { adapterType: 'crm', externalId: company.id, recordType, data: { ...company } };
    },
    updateRecord: async (input) => {
      const { externalId, recordType, fields } = input;
      await authorised();
      const company = store.update(tenant, externalId, definedTexts(store.fieldsOf(tenant), fields));
      if (company === undefined) return { notFound: true };
      return { adapterType: 'crm', externalId, recordType, data: { ...company }, association: containerAssociation(input) };
    },
    deleteRecord: async () => {
      throw new Error('crm: a movement may not delete a company');
    },
    listEventTypes: async () => [{ tag: COMPANY_CREATED, positionType: COMPANY }],
  };
  return adapter;
}

/** The CRM module over `store`. */
export function crmModule(store: CompanyStore) {
  return defineModule({
    kind: 'adapter',
    name: '@acme/crm',
    manifest: MANIFEST,
    credentials: [{ name: 'crm', kind: 'static', fields: [{ name: 'api_key' }] }],
    create: (ctx) => crmAdapter(ctx, store),
  });
}
