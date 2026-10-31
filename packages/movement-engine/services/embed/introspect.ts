// What an embedder's catalog reads of a live adapter: its entry points and
// each one's descriptor, projected into the checker's instance schema. The
// hosted product caches this per install (instance_cache.ts) and listen-fire asks each
// external the same two questions (crates/lf check.rs); an embedder asks
// them of the adapter it loaded in process.

import { undeclaredArrivalField, unreadableAnswerShapeFrom, unreadableListening, unreadableLiteralsFrom, unreadableOwnedField, unreadableSettingsBecome } from 'engine-contracts/catalog';
import type { InstanceSchema } from 'movement-lang';

import type { Adapter, AdapterManifest } from '../translation_graph/adapter';
import { instanceSchemaFromDescriptors } from '../translation_graph/movement/schema_projection';

/** The instance schema `adapter` answers today, with the projection's notes
 *  (a name two entries share, a type it could not describe). */
export async function introspectAdapter(
  adapter: Adapter,
  manifest: Pick<AdapterManifest, 'adapterType' | 'methods' | 'listenSettingsBecome'>,
): Promise<{ schema: InstanceSchema; notes: string[] }> {
  const entries = await adapter.listEntryPoints();
  const described = await Promise.all(entries.map(async (entry) => [entry.typeId, await adapter.describe(entry.typeId)] as const));
  const descriptors = new Map(described.flatMap(([typeId, descriptor]) => (descriptor ? [[typeId, descriptor] as const] : [])));
  for (const [typeId, descriptor] of descriptors) {
    for (const field of descriptor.fields) {
      const refusal = unreadableOwnedField(field);
      if (refusal !== undefined) throw new Error(`${manifest.adapterType} describes '${typeId}': ${refusal}`);
    }
    for (const reference of descriptor.references) {
      const refusal =
        undeclaredArrivalField(reference, descriptors) ??
        unreadableLiteralsFrom(reference, descriptors) ??
        unreadableAnswerShapeFrom(reference, descriptor, descriptors) ??
        unreadableListening({ reference, owner: typeId }, entries, descriptors);
      if (refusal !== undefined) throw new Error(`${manifest.adapterType} describes '${typeId}': ${refusal}`);
    }
  }
  for (const entry of entries) {
    const refusal = unreadableListening({ entry }, entries, descriptors);
    if (refusal !== undefined) throw new Error(`${manifest.adapterType} lists '${entry.typeId}': ${refusal}`);
  }
  if (manifest.listenSettingsBecome !== undefined) {
    const refusal = unreadableSettingsBecome(manifest.listenSettingsBecome, entries, descriptors);
    if (refusal !== undefined) throw new Error(`${manifest.adapterType} declares ${refusal}`);
  }
  return instanceSchemaFromDescriptors({
    adapterType: manifest.adapterType,
    entries,
    descriptors,
    supportsInPlaceUpdate: (manifest.methods ?? []).includes('updateRecord'),
    edgesCarryProperties: adapter.runtimeCapabilities().traversal.edgeProperties,
  });
}
