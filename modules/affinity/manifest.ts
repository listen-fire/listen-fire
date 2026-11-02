// Affinity's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// Affinity without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { AFFINITY_CHANGE_KINDS, AFFINITY_CHANGED_ENTITIES, AFFINITY_CHANGES_EDGE, type AffinityChangeKind, type AffinityChangedEntity } from './changes';
import { AFFINITY_HANDBOOK_SECTION } from './handbook_section';
import { AFFINITY_ADAPTER_TYPE, ENTITY_DISPLAY_NAMES } from './types';

/** What a 0.12 listen naming `entity`'s own events becomes: a listen on that
 *  entity's `Changes`, its events compared as `Kind`. An `updated` change is
 *  also a field value set or cleared on the entity, which 0.12 heard only as a
 *  `field_value` event, so a listen naming `<entity>.updated` hears more: its
 *  rewrite says so and is never applied safely. */
function changesOf(entity: AffinityChangedEntity, kind: AffinityChangeKind) {
  const recordType = ENTITY_DISPLAY_NAMES[entity];
  return {
    ...(kind === 'updated'
      ? { changed: `\`Kind == "updated"\` also hears each field value set or cleared on the ${recordType.toLowerCase()}, which 0.12 heard only as field_value events: add \`\`AND c.\`Field Change\` == null\`\` to hear the ${recordType.toLowerCase()}'s own updates alone` }
      : {}),
    path: [recordType, AFFINITY_CHANGES_EDGE],
    aliases: [entity.charAt(0), 'c'],
    // The 0.12 record a fired parameter was typed as.
    paramFrom: recordType,
    keys: {
      events: { hop: 1, field: 'Kind', op: 'in' as const, values: Object.fromEntries(AFFINITY_CHANGE_KINDS.map((kind) => [`${entity}.${kind}`, kind])) },
    },
  };
}

const ORGANIZATION_CHANGES = changesOf('organization', 'created');

/** The events of the entities whose changes a mapping can state. */
const ENTITY_EVENTS = AFFINITY_CHANGED_ENTITIES.flatMap((entity) => AFFINITY_CHANGE_KINDS.map((kind) => [`${entity}.${kind}`, kind] as const));

/**
 * Static manifest. A write target plus inbound webhooks; a real
 * `createRecord`/`updateRecord` makes it writable, and Affinity v1 has
 * first-class deletes (org/person/list-entry/note) so `deleteRecord` is real
 * too — `delete <handle>` works against Affinity records.
 *
 */
export const AFFINITY_MANIFEST: AdapterManifest = {
  adapterType: AFFINITY_ADAPTER_TYPE,
  displayName: 'Affinity',
  website: 'https://www.affinity.co',
  category: 'CRM',
  description:
    'The Affinity CRM. Read organizations, people, opportunities, and lists — ' +
    'plus the history on each record (notes, files, reminders, interactions, ' +
    'relationship strengths) — and create or update records from your movements.',
  supportedTriggers: ['webhook'],
  methods: [
    'listEntryPoints', 'describe', 'edgesFrom', 'resolveEntity', 'getRelated',
    'createRecord', 'updateRecord', 'deleteRecord', 'readRecord',
    'linkRecords', 'unlinkRecords',
    'preprocessInbound', 'awaitKeys', 'ensureEventSubscription', 'removeEventSubscription',
  ],
  handbookSection: AFFINITY_HANDBOOK_SECTION,
  requiredCredentialType: 'AFFINITY',
  triggerKinds: ['AFFINITY'],
  introspectedSchema: true,
  authoringHints:
    'Listen on a record’s Changes, narrowed by Kind (created, updated, deleted) and, when a field value ' +
    'changed, by Field (the field’s name), Field Change (set, changed, cleared) and its value, Current (set or ' +
    'changed to) or Previous (cleared), each holding only that field: crm-[:`List Entry — Master Deals List`]->-[c:Changes WHERE ' +
    'c.Field == "Status"]->, or WHERE exists(c.Current) AND c.Current.Status == "Passed". An organization’s Changes are OrganizationChange (a person’s PersonChange, an ' +
    'opportunity’s OpportunityChange, a list’s entry’s `List Entry Change — <list>`); walk the change’s ' +
    'Organization (Person, Opportunity, List Entry) edge for the record as it is now.',
  // Each 0.12 listen naming an organization's, a person's or an opportunity's
  // own events becomes a listen on its `Changes` (`byEvent`). One naming none
  // heard every record's events, on several records' `Changes`, so it has no
  // one rewrite (`absent`). One naming a list entry's, a field value's, a
  // note's or a reminder's has none either: no mapping names those events,
  // since the record type they arrive on is the workspace's own (a list).
  listenSettingsBecome: {
    ...ORGANIZATION_CHANGES,
    keys: { events: { ...ORGANIZATION_CHANGES.keys.events, values: Object.fromEntries(ENTITY_EVENTS), absent: ENTITY_EVENTS.map(([event]) => event) } },
    byEvent: Object.fromEntries(AFFINITY_CHANGED_ENTITIES.flatMap((entity) => AFFINITY_CHANGE_KINDS.map((kind) => [`${entity}.${kind}`, changesOf(entity, kind)]))),
  },
  triggerExpectation:
    'Listen-Fire registers one Affinity webhook for a connection when a listen on a record’s Changes ' +
    'goes live (Affinity allows at most 3 per instance), taking every organization, person, opportunity, ' +
    'list entry and field value event. A change arrives on the Changes of the record it is about: created, ' +
    'a field’s value set, changed or cleared (updated, Field names the field, Field Change says which, and ' +
    'Current or Previous holds the value: a deal’s stage is a field of its list entry) or deleted. Affinity ' +
    'sends no value a change replaced. A redelivery of the same change runs nothing. It does not fire on notes, reminders, ' +
    'files or lists themselves.',
  vocabulary: {
    icon: {
      d: "M36.2425 20.7692C36.2418 21.1012 36.2 21.4318 36.118 21.7535L38.1678 23.8166C42.1219 27.8365 42.0939 34.2895 38.1051 38.2749C34.1162 42.2603 27.6577 42.2883 23.6345 38.3376L21.6018 36.3067C20.9344 36.4836 20.2323 36.4836 19.5649 36.3067L17.5451 38.3269C13.5318 42.3373 7.02457 42.3378 3.01071 38.3279C-1.00315 34.3181-1.00363 27.8163 3.00964 23.8059L5.28054 21.5348C5.17894 21.0251 5.17894 20.5004 5.28054 19.9907L3.01178 17.7217C0.415654 15.1274-0.598046 11.3463 0.352536 7.80279C1.30312 4.25924 4.07356 1.49156 7.62028 0.542315C11.167-0.406933 14.9511 0.606461 17.5473 3.20076L19.3266 4.97862C20.1441 4.71219 21.0259 4.71745 21.8401 4.99363L23.6366 3.19862C27.6599-0.752113 34.1184-0.724137 38.1072 3.2613C42.0961 7.24674 42.1241 13.6997 38.17 17.7196L36.1137 19.7741C36.1991 20.0989 36.2424 20.4333 36.2425 20.7692ZM26.4135 5.98842L24.4818 7.91854C24.5467 8.2057 24.5798 8.49913 24.5805 8.79353C24.5808 9.21316 24.5141 9.63014 24.383 10.0288L31.2472 16.8807C31.5683 16.7978 31.8987 16.756 32.2303 16.7564C32.6258 16.7559 33.0193 16.8137 33.3979 16.9279L35.3791 14.9463C37.7845 12.461 37.7514 8.50761 35.3046 6.06287C32.8577 3.61814 28.901 3.58501 26.4135 5.98842ZM24.4521 31.4274L31.2283 24.6548C31.9434 24.8416 32.6966 24.8245 33.4026 24.6055L35.3859 26.5871C37.7913 29.0725 37.7582 33.0258 35.3113 35.4706C32.8645 37.9153 28.9078 37.9484 26.4203 35.545L24.4199 33.5441C24.5261 33.1789 24.5803 32.8006 24.5808 32.4204C24.5809 32.0852 24.5376 31.7515 24.4521 31.4274ZM21.7277 28.5837L28.3816 21.9355L28.3837 21.9398C28.1505 21.1766 28.1505 20.3612 28.3837 19.598L21.483 12.7031C20.893 12.845 20.2781 12.8487 19.6864 12.7138L12.9961 19.3942C13.3195 20.28 13.3195 21.2514 12.9961 22.1371L19.4353 28.5709C20.1844 28.3522 20.9811 28.3566 21.7277 28.5837ZM16.7583 10.0723L16.7551 10.0755C16.5154 9.3679 16.4808 8.60699 16.6553 7.88053L14.76 5.98686C12.2725 3.58345 8.31578 3.61658 5.86896 6.06132C3.42214 8.50605 3.38898 12.4594 5.79444 14.9448L7.85714 17.0036C8.54324 16.7504 9.2859 16.691 10.0036 16.832L16.7551 10.0755L16.7562 10.0787L16.7583 10.0723ZM10.0035 24.7069C9.2862 24.8478 8.54394 24.7899 7.85714 24.5396L5.79444 26.5877C3.38898 29.0731 3.42214 33.0264 5.86896 35.4711C8.31578 37.9159 12.2725 37.949 14.76 35.5456L16.7175 33.5876C16.6031 33.2093 16.5452 32.8162 16.5458 32.4209C16.5455 32.0704 16.5917 31.7214 16.6832 31.383L10.0035 24.7069Z",
      fill: true,
      viewBox: "0 0 42 42",
    },
    eventPhrase: {
      // No per-event phrasing today (organization/person/opportunity/list
      // entry/note/reminder create/update/delete all shared one generic
      // sentence in the former switch) — `default` mirrors that.
      default: [{ template: 'When a record changes in Affinity' }],
    },
  },
};
