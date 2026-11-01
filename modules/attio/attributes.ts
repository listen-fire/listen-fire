// Attio's attribute vocabulary and the catalogue reads a client answers.

import { z } from 'zod';

/**
 * The attribute types we map deliberately. Attio owns this vocabulary and adds
 * to it, so this is the KNOWN set, not the legal one — see the validator below.
 */
const KNOWN_ATTIO_ATTRIBUTE_TYPES = [
  'text',
  'number',
  'checkbox',
  'currency',
  'date',
  'timestamp',
  'rating',
  'status',
  'select',
  'record-reference',
  'actor-reference',
  'location',
  'domain',
  'email-address',
  'phone-number',
  'interaction',
  'personal-name',
  'file',
] as const;

/**
 * OPEN, deliberately. This vocabulary belongs to Attio, and a closed enum here
 * meant one attribute of an unrecognised type failed the whole `z.array(...)`
 * parse — so a single new attribute type anywhere in a workspace blanked the
 * ENTIRE Attio schema (`schema: null`), not just its own field. An unknown type
 * must cost exactly its own field: it parses, and `mapAttributeTypeToFieldKind`
 * routes it to the string primitive.
 *
 * Every consumer only ever COMPARES this against a known literal, so widening
 * it changes no behaviour for the types we do map.
 */
const attioAttributeTypeValidator = z.string();

const attributeConfigValidator = z.object({
  id: z.string(),
  name: z.string(),
  type: attioAttributeTypeValidator,
  isMulti: z.boolean(),
  relationshipAttributeId: z.string().optional(),
  relationshipObjectId: z.string().optional(),
  /**
   * For `record-reference` attributes, the object ids the reference is allowed
   * to land on — `config.record_reference.allowed_object_ids` on the wire.
   *
   * This is the ONLY target metadata Attio gives a record-reference created in
   * the UI: such an attribute has `relationship: null` (Attio only mints the
   * paired `relationship` for its own built-in links), so reading targets from
   * `relationshipObjectId` alone made every UI-created reference invisible.
   *
   * Absent / empty means UNRESTRICTED (the reference may point at any object),
   * which is not a target list and must not be expanded into one.
   */
  allowedObjectIds: z.array(z.string()).optional(),
  isRequired: z.boolean().optional(),
  isUnique: z.boolean().optional(),
  isWritable: z.boolean().optional(),
  apiSlug: z.string().optional(),
  options: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});

type AttioAttribute = z.infer<typeof attributeConfigValidator>;

interface AttioConfigurer {
  getWorkspaceSlug(): Promise<string>;
  listLists(): Promise<
    {
      id: string;
      name: string;
      parentObjectSlugs: string[];
      apiSlug: string | null;
    }[]
  >;
  listObjects(): Promise<{ id: string; name: string; singular: string; slug: string | null }[]>;
  listAttributes(params: { objectId?: string; listId?: string }): Promise<AttioAttribute[]>;
  listAttributeOptions(params: {
    objectId?: string;
    listId?: string;
    attributeId: string;
  }): Promise<{ id: string; name: string }[]>;
  listStatuses(params: {
    objectId?: string;
    listId?: string;
    attributeId: string;
  }): Promise<{ id: string; name: string }[]>;
  listWorkspaceMembers(): Promise<
    { id: string; firstName: string; lastName: string; email: string }[]
  >;
}

/** One attribute's value as a record holds it (Attio's array of typed
 *  values), read as the plain value a field compares and reads as. */
export function extractAttioValue(raw: unknown): unknown {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const first = raw[0];
  if (typeof first !== 'object' || first === null) return first;

  const obj = first as Record<string, unknown>;
  return (
    obj.value ??
    obj.full_name ??
    obj.first_name ??
    obj.domain ??
    obj.email_address ??
    obj.original_email_address ??
    // status / select values nest the chosen option under `status` / `option`
    // with a human `title` — read that back, so the field compares and
    // interpolates as the plain option name ("Lead"), never as the raw
    // envelope. Without this, every predicate over a status field (including
    // the engine's re-check of a pushed-down filter) compares an object to a
    // string and silently matches nothing.
    optionTitle(obj.status) ??
    optionTitle(obj.option) ??
    // actor-reference ("User") values — read back the workspace-member id as
    // a clean string so the field reads consistently with its `string` kind
    // (rather than the raw `[{ referenced_actor_type, referenced_actor_id }]`).
    obj.referenced_actor_id ??
    raw
  );
}

/** The `title` of a nested status/select option object, or undefined. */
export function optionTitle(nested: unknown): string | undefined {
  if (typeof nested !== 'object' || nested === null) return undefined;
  const title = (nested as Record<string, unknown>).title;
  return typeof title === 'string' ? title : undefined;
}

export type { AttioConfigurer, AttioAttribute };
export { attributeConfigValidator, attioAttributeTypeValidator, KNOWN_ATTIO_ATTRIBUTE_TYPES };
