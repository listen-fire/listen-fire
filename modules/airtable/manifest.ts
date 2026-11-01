// Airtable's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Airtable without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { AIRTABLE_HANDBOOK_SECTION } from './handbook_section';
import { AIRTABLE_BASES_EDGE } from './schema_catalog';
import { AIRTABLE_ADAPTER_TYPE, BASE_META_TYPE } from './types';
import { AIRTABLE_CHANGE_KINDS, AIRTABLE_CHANGES_EDGE, AIRTABLE_TABLES_EDGE } from './webhook';

/**
 * Static manifest. A full create/update/delete write surface makes it
 * writable; a table's `Changes` and a base's `Tables` are what a listen hears,
 * through Airtable's webhooks (two per base: its rows, its tables).
 */
export const AIRTABLE_MANIFEST: AdapterManifest = {
  adapterType: AIRTABLE_ADAPTER_TYPE,
  displayName: 'Airtable',
  website: 'https://airtable.com',
  category: 'Spreadsheets',
  description:
    'Airtable. Read your bases, create, update, or delete rows from your ' +
    'movements, and run movements when rows change in a table.',
  authoringHints:
    'Each Airtable base holds its own tables, so this connection publishes ' +
    'ONE `Bases` collection, not the tables. Reach a base by narrowing it — ' +
    '`-[b:Bases WHERE b.Name == "Sales CRM"]->` — and its tables come back as that ' +
    'base\'s edges. To write to a table, start the instance at its base — ' +
    '`airtable(credentials: acme, base: "Sales CRM")` — and the base\'s tables ' +
    'become the types you name, by their own names (`Companies`). One base per ' +
    'instance: to reach a second base, construct a second instance. To run on a ' +
    'table\'s changes, listen on its `Changes`: ' +
    '`listen to at-[b:Bases WHERE b.Name == "Finance"]->-[t:Tables WHERE t.Name == "Expenses"]->-[c:Changes WHERE c.Kind == "created"]-> fire f`.',
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'resolveEntity', 'getFieldValue',
    'getRelated', 'createRecord', 'updateRecord', 'deleteRecord', 'readRecord',
    'preprocessInbound', 'awaitKeys', 'ensureEventSubscription', 'removeEventSubscription', 'refreshEventSubscription',
  ],
  requiredCredentialType: 'AIRTABLE',
  triggerKinds: ['AIRTABLE'],
  introspectedSchema: true,
  handbookSection: AIRTABLE_HANDBOOK_SECTION,
  vocabulary: {
    icon: {
      d: 'M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z',
      fill: true,
    },
  },
  // The change kinds a `listen to <airtable> { events: [...] }` can subscribe
  // to — projected as the `events` listen-config value vocabulary and folded
  // into the external webhook registration's `changeTypes`.
  // Entry position: `airtable(credentials: X, base: "MASTER")` starts the
  // instance AT that base, so its tables are the types a movement names.
  // Omitted, the instance sits at the workspace root, where the types are the
  // BASES and no table is nameable by name. Value enum = the base names, drawn
  // from the `Bases` collection off the meta node.
  positionArgs: [{ name: 'base', optionsFrom: BASE_META_TYPE, label: 'Base' }],
  // A 0.12 listen (`{ base, table, events, field, becomes }`) is a listen on
  // the table's `Changes`: the base and table narrow their hops by `Id`, the
  // events by `Kind`, and `field` and `becomes` compare the row before and
  // after the change (`fieldChange`): the field changed, or came to hold the
  // value. A change is one per row an edit touched, as 0.12 ran once per
  // update, so each rewrite keeps the meaning. A connection positioned at the
  // base drops the `Bases` hop.
  listenSettingsBecome: {
    path: [AIRTABLE_BASES_EDGE, AIRTABLE_TABLES_EDGE, AIRTABLE_CHANGES_EDGE],
    aliases: ['b', 't', 'c'],
    // The 0.12 event a fired parameter was typed as.
    paramFrom: 'Record Change',
    keys: {
      base: { hop: 0, field: 'Id', op: 'eq' },
      table: { hop: 1, field: 'Id', op: 'eq' },
      events: { hop: 2, field: 'Kind', op: 'in', values: Object.fromEntries(AIRTABLE_CHANGE_KINDS.map((kind) => [`record.${kind}`, kind])) },
    },
    fieldChange: { hop: 2, field: 'field', becomes: 'becomes', current: 'Current', previous: 'Previous' },
  },
  triggerExpectation:
    'Listen-Fire registers one Airtable webhook on the rows of each base whose tables a listen on their ' +
    '`Changes` watches, however many it watches, and one per base whose tables the listen narrows by a ' +
    'WHERE (Airtable\'s schema webhook): two per base, the most Airtable lets one connected app make. ' +
    'A change in a table of the base the listen does not watch runs nothing. Airtable notifies ' +
    'that something changed and Listen-Fire pulls the changes, usually within seconds but coalesced by ' +
    'Airtable (rapid edits can land as one batch). A change arrives on its table\'s `Changes`, one per row ' +
    'an edit touched: created, updated or deleted, with the row as it was (`Previous`) and as the edit left it ' +
    '(`Current`); its `Record` is the row as it is now, read from Airtable. A table renamed into or out of a listen\'s ' +
    'WHERE is watched, or no longer, from the moment Airtable reports the rename; changes it had before ' +
    'are not replayed.',
};
