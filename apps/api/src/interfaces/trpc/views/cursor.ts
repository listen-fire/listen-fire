export type KeysetCursor = { createdAt: string; id: string };

/**
 * Base64url-encoded `created_at, id` keyset cursor, shared by every router
 * paginating on that pattern (see `journey.ts`, `ops.ts`).
 */
function encodeCursor(cursor: KeysetCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function decodeCursor(raw: string): { createdAt: Date; id: string } {
  const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString()) as KeysetCursor;
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}

export { encodeCursor, decodeCursor };
