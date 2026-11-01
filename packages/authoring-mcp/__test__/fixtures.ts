// A tenant's catalog as a host builds it (`buildCatalogSnapshot`): a CRM whose
// `Company` has a required name and a select, connected as `workspace`, and
// the run host's `manual` unit.

import type { SchemaFieldType } from 'movement-lang';

import type { TenantCatalog } from '../host';

const company: Record<string, SchemaFieldType> = {
  Name: 'text',
  Stage: { kind: 'enum', options: ['Lead', 'Customer'] },
};

export const CATALOG: TenantCatalog = {
  snapshot: {
    contractVersion: 3,
    adapters: {
      manual: {
        constructionArgs: [],
        canFire: true,
        schemaShape: 'introspected',
        schemas: {
          '': {
            positions: { Invocation: { properties: { 'Fired at': 'date', Text: 'text' }, edges: {} } },
            collections: { Invocations: { target: 'Invocation', readable: false, listenable: true, delivery: 'connection' } },
            writableRoots: {},
          },
        },
      },
      crm: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        declaredCredentials: ['crm'],
        canFire: true,
        description: "The product's own CRM.",
        schemaShape: 'introspected',
        schemas: {
          workspace: {
            positions: { Company: { properties: { ...company }, edges: {} } },
            collections: { Company: { target: 'Company', listenable: true, delivery: 'connection' } },
            writableRoots: {
              Company: { fields: { ...company }, resultShape: { externalId: 'text', url: 'text', ...company }, requiredFields: ['Name'] },
            },
            supportsInPlaceUpdate: true,
          },
        },
      },
      mail: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        schemaShape: 'introspected',
        schemas: {},
      },
    },
    credentials: { workspace: { adapters: ['crm'], credential: 'crm' } },
    plugins: {},
  },
  connections: [{ name: 'workspace', system: 'crm' }],
};

export const PRELUDE = `import { crm } from adapters
import { workspace } from credentials

app = connect crm using workspace
`;

/** A program that files the text it is run on as a company at `stage`. */
export const fileAs = (stage: string) => `${PRELUDE}
function file_lead(run: <manual-[:Invocations]->>) {
  write app-[:Company]-> { Name: "\${run.Text}", Stage: "${stage}" }
}

listen to manual-[:Invocations]-> fire file_lead
`;
