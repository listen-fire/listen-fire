// The run host's `manual` unit, as `listen-fire` builds it in (crates/lf/src/units.rs):
// a source every host has, which a movement listens to with no import and no
// `connect` (`listen to manual-[:Invocations]-> fire backfill`). Each run the
// embedder asks for (`run`) is an arrival on `Invocations`, with the text
// given as the Invocation's `Text`. A module the embedder registers under the
// adapter type `manual` replaces it, as a project external of that name
// replaces the unit in `listen-fire`.

import { randomUUID } from 'node:crypto';

import { BASE_RUNTIME_CAPABILITIES, type Arrival } from 'engine-contracts';
import type { Adapter, AdapterManifest } from 'movement-engine/public/adapter';

export const MANUAL = 'manual';

const INVOCATION = 'invocation';

/** The unit's one edge: what a manual run lands on. */
export const INVOCATIONS = 'Invocations';

export const MANUAL_MANIFEST: AdapterManifest = {
  adapterType: MANUAL,
  displayName: 'Manual',
  supportedTriggers: ['webhook'],
  methods: ['listEntryPoints', 'describe', 'getFieldValue', 'getRelated'],
  introspectedSchema: true,
  // A 0.12 `listen to manual fire f` is written as a traversal so.
  listenSettingsBecome: { path: [INVOCATIONS], aliases: ['i'], paramFrom: 'Invocation', keys: {} },
};

const field = (fieldId: string, displayName: string, kind: 'string' | 'date' | 'number', required: boolean) => ({
  fieldId,
  displayName,
  kind,
  writable: false,
  required,
});

const DESCRIPTORS = [
  {
    typeId: INVOCATION,
    displayName: 'Invocation',
    description: 'One Run-now press — when, by whom, and any text or files supplied.',
    fields: [
      field('firedAt', 'Fired at', 'date', true),
      field('actorEmail', 'Run by (email)', 'string', false),
      field('actorName', 'Run by (name)', 'string', false),
      field('text', 'Text', 'string', false),
      field('content', 'Content', 'string', false),
    ],
    references: [{ fieldId: 'files', targetTypeId: 'file', cardinality: 'many' as const, direction: 'outgoing' as const, name: 'Files', writable: false }],
  },
  {
    typeId: 'file',
    displayName: 'File',
    fields: [field('name', 'Name', 'string', true), field('contentType', 'Content Type', 'string', true), field('size', 'Size', 'number', false)],
    references: [],
  },
];

/** The unit's adapter: its types, and an event's fields read off its data. */
export function manualAdapter(): Adapter {
  const descriptorOf = (typeRef: string) => DESCRIPTORS.find((d) => d.typeId === typeRef || d.displayName === typeRef) ?? null;
  return {
    adapterType: MANUAL,
    supportedTriggers: ['webhook'],
    runtimeCapabilities: () => BASE_RUNTIME_CAPABILITIES,
    listEntryPoints: async () => [
      { typeId: INVOCATION, displayName: 'Invocation', collectionName: INVOCATIONS, writable: false, readable: false, listenable: true, delivery: 'connection' },
      { typeId: 'file', displayName: 'File', writable: false, readable: false },
    ],
    describe: async (typeId) => descriptorOf(typeId),
    resolveEntity: async () => ({ candidates: [] }),
    // An Invocation's fields are its landing's, by display name
    // (`invocationOf`); read by id or by name.
    getFieldValue: async ({ position, fieldId }) => {
      const descriptor = descriptorOf(position.recordType ?? INVOCATION);
      const declared = descriptor?.fields.find((f) => f.fieldId === fieldId || f.displayName === fieldId);
      const data: unknown = position.identity.data;
      const held = (key: string): unknown => (data !== null && typeof data === 'object' ? (Reflect.get(data, key) ?? undefined) : undefined);
      const id = declared?.fieldId ?? fieldId;
      // A run started with no text reads `""`, never absent: both are text.
      if (id === 'text' || id === 'content') {
        const text = held('Text') ?? held('text');
        return typeof text === 'string' ? text : '';
      }
      return held(id) ?? (declared !== undefined ? held(declared.displayName) : undefined) ?? null;
    },
    getRelated: async () => [],
    createRecord: async () => {
      throw new Error('the manual unit is not written to');
    },
    updateRecord: async () => ({ notFound: true }),
    deleteRecord: async () => {
      throw new Error('the manual unit is not written to');
    },
  };
}

/** The arrival a manual run is, on `Invocations`: when it was asked for,
 *  and the text given. Each is its own invocation. */
export function invocationOf(input: { firedAt: Date; text?: string }): Exclude<Arrival, { gone: true }> {
  return {
    edge: INVOCATIONS,
    identity: `invocation:${randomUUID()}`,
    landing: { recordType: 'Invocation', fields: { 'Fired at': input.firedAt.toISOString(), ...(input.text !== undefined ? { Text: input.text } : {}) } },
  };
}
