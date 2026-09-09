import type { Chapter } from '../types';

export const files: Chapter = {
  id: 'files',
  title: 'Handling files',
  content: `## Handling files

Records are JSON, but files — documents, attachments — are not: their
bytes never ride the protocol envelope. A file moves as a **FileRef**, a
small descriptor that points at the bytes without carrying them.

### The FileRef shape

A FileRef on the wire looks like:
\`\`\`json
{
  "name": "deck.pdf",
  "contentType": "application/pdf",
  "size": 248120,
  "source": { "ownerAdapterType": "acme_crm", "handle": "<your opaque file id>" }
}
\`\`\`
- \`source.ownerAdapterType\` is the slug of the adapter that OWNS the
  bytes; \`source.handle\` is any opaque string YOUR server needs to
  locate that file later — Listen-Fire treats it as a black box.
- \`name\` / \`contentType\` / \`size\` are optional metadata.

### Exposing files your system owns (reading files OUT)

When a record in your system has a file — an attached document, a
contract PDF — return a FileRef for it so Listen-Fire can pull the bytes:

1. From a file-typed field (via \`getFieldValue\`, \`getRelated\`, or a
   read result), return a FileRef whose \`source.ownerAdapterType\` is
   YOUR adapter slug and whose \`source.handle\` locates the file in your
   system.
2. Implement \`resolveFileRef\`. Listen-Fire calls it with the ref you returned
   and expects back a URL it can fetch the bytes from:
   \`\`\`json
   { "url": "https://crm.acme.example/files/abc123?token=…", "contentType": "application/pdf" }
   \`\`\`
   Listen-Fire fetches that URL server-side, so it can be authenticated and
   short-lived — mint a signed, expiring link. The bytes come back over
   plain HTTP, never through the JSON protocol.
3. List \`resolveFileRef\` in your manifest \`methods\`.

That is the whole contract for reading files out of your system.

### Writing a file INTO your system (receiving files)

A write's \`fields\` (or its node-level \`resources\`) can carry a file
that originated in ANOTHER system — an email attachment Listen-Fire is pushing
toward your CRM. Raw bytes can't ride the JSON envelope, so Listen-Fire buffers
them to a short-lived, fetchable URL and puts it on the FileRef:
\`\`\`json
{
  "name": "deck.pdf",
  "contentType": "application/pdf",
  "source": { "ownerAdapterType": "email", "handle": "…" },
  "url": "https://app.listen-fire.example/api/files/blob/abc123"
}
\`\`\`
- GET \`url\` to fetch the bytes and store them in your system. The link
  is short-lived (about an hour) and served by Listen-Fire, so fetch it at write
  time, not later.
- \`source\` names the originating system; you can ignore it — \`url\` is
  the byte channel.
- Raw bytes never ride the JSON envelope; always fetch from \`url\`.

### Resources

Node-level \`resources\` on a write carry file provenance the same way — a
\`fileRef\` with a fetchable \`url\` (a resource's own top-level \`url\`
field is display-only). Fetch and store their bytes exactly as above.`,
};
