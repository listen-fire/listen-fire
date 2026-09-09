import EvidenceType from '../../generated/kysely/knowledge/EvidenceType';

/** pg returns custom enum arrays as raw strings "{a,b}" — normalize to JS arrays */
function parseEnumArray(raw: unknown): string[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const inner = raw.replace(/^\{|\}$/g, '');
    return inner ? inner.split(',') : [];
  }
  return null;
}

/**
 * Check if a property type allows writes from a given evidence type.
 * null writable_by means all evidence types are allowed (backward compatible).
 * Handles raw pg strings defensively via parseEnumArray.
 */
function isWritableBy(
  writableBy: EvidenceType[] | string | null,
  evidenceType: EvidenceType,
): boolean {
  const parsed = parseEnumArray(writableBy);
  if (parsed == null) return true;
  return parsed.includes(evidenceType);
}

export { isWritableBy, parseEnumArray };
