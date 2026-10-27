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
    contractVersion: 1,
    adapters: {
      manual: {
        constructionArgs: [],
        canFire: true,
        schemaShape: 'introspected',
        schemas: {
          '': {
            positions: { Invocation: { properties: { 'Fired at': 'date', Text: 'text' }, edges: {} } },
            collections: {},
            writableRoots: {},
            eventPosition: 'Invocation',
            eventPositions: [{ position: 'Invocation' }],
          },
        },
      },
      crm: {
        constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
        declaredCredentials: ['crm'],
        canFire: true,
        triggerConfig: ['events'],
        triggerConfigOptions: { events: ['company.created'] },
        description: "The product's own CRM.",
        schemaShape: 'introspected',
        schemas: {
          workspace: {
            positions: { Company: { properties: { ...company }, edges: {} } },
            collections: { Company: { target: 'Company' } },
            writableRoots: {
              Company: { fields: { ...company }, resultShape: { externalId: 'text', url: 'text', ...company }, requiredFields: ['Name'] },
            },
            supportsInPlaceUpdate: true,
            eventPosition: 'Company',
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
function file_lead(run: <manual-[:Invocation]->>) {
  write app-[:Company]-> { Name: "\${run.Text}", Stage: "${stage}" }
}

listen to manual fire file_lead
`;
