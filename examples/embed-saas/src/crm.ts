// The SaaS's own product, as the module its customers' movements reach: a
// tiny CRM with one record type, `Company`, and one event a listen may
// choose, `company.created`. Each customer defines its own fields on
// `Company` (a text field, or a select with its own options), so the schema
// the module describes is that customer's. The records and the field
// definitions live in the SaaS's own store (`CompanyStore`), one tenant's
// apart from another's; the module only answers the adapter protocol over
// them.

import type { Adapter, AdapterManifest, DiscriminableEvent } from '@listen-fire/engine/public/adapter';
import { BASE_RUNTIME_CAPABILITIES, containerAssociation } from '@listen-fire/engine/public/adapter';
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
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const data = position.identity.kind === 'stable' ? position.identity.data : undefined;
      return data !== null && typeof data === 'object' ? (Reflect.get(data, fieldId) ?? null) : null;
    },
    getRelated: async () => [],
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
