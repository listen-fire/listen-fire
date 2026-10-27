// The run host's `manual` unit, as `lf` builds it in (crates/lf/src/units.rs):
// a source every host has, which a movement listens to with no import and no
// `connect` (`listen to manual fire backfill`). It fires when the embedder
// asks (`run`), with the text given as the Invocation's `Text`. A module the
// embedder registers under the adapter type `manual` replaces it, as a
// project external of that name replaces the unit in `lf`.

import { BASE_RUNTIME_CAPABILITIES } from 'engine-contracts';
import type { Adapter, AdapterManifest, DiscriminableEvent } from 'movement-engine/public/adapter';

export const MANUAL = 'manual';

const INVOCATION = 'invocation';

export const MANUAL_MANIFEST: AdapterManifest = {
  adapterType: MANUAL,
  displayName: 'Manual',
  supportedTriggers: ['webhook'],
  methods: ['listEntryPoints', 'describe', 'getFieldValue', 'getRelated'],
  introspectedSchema: true,
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
      { typeId: INVOCATION, displayName: 'Invocation', writable: false, readable: false, fires: true },
      { typeId: 'file', displayName: 'File', writable: false, readable: false },
    ],
    describe: async (typeId) => descriptorOf(typeId),
    resolveEntity: async () => ({ candidates: [] }),
    getFieldValue: async ({ position, fieldId }) => {
      const descriptor = descriptorOf(position.recordType ?? INVOCATION);
      const id = descriptor?.fields.find((f) => f.fieldId === fieldId || f.displayName === fieldId)?.fieldId ?? fieldId;
      const data: unknown = position.identity.data;
      const value = data !== null && typeof data === 'object' ? Reflect.get(data, id === 'content' ? 'text' : id) : undefined;
      // A run started with no text reads `""`, never absent: both are text.
      if (id === 'text' || id === 'content') return typeof value === 'string' ? value : '';
      return value ?? null;
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

/** The event a manual run is: when it was asked for, and the text given. */
export function manualEvent(input: { firedAt: Date; text?: string }): DiscriminableEvent {
  return {
    payload: { firedAt: input.firedAt.toISOString(), ...(input.text !== undefined ? { text: input.text } : {}) },
    tag: INVOCATION,
    eventType: INVOCATION,
    recordType: INVOCATION,
  };
}
