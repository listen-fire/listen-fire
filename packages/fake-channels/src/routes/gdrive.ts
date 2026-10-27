// Fake Google Drive (v3 REST subset) — serves the googleapis client with its
// rootUrl pointed here, so BOTH the JSON endpoints (/drive/v3/…) and the
// multipart upload endpoint (/upload/drive/v3/…) work. Entities: one 'file'
// per Drive item (folders are files with the folder mimeType), fields
// mirroring the real API: { id, name, mimeType, parents, size, md5Checksum,
// sha256Checksum, webViewLink }, beside the bytes (`contentBase64`, exact)
// and their text (`content`, only when the bytes are utf-8 text). A file
// seeded with `granted: false` stands for one outside the app's drive.file
// grant: like the real API, the fake answers 404 for it.

import { createHash } from 'node:crypto';
import { Router } from 'express';
import express from 'express';
import type { EntityStore } from '../store';

const SVC = 'gdrive';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

function fileOut(data: Record<string, unknown>): Record<string, unknown> {
  const { content: _content, contentBase64: _bytes, granted: _granted, ...rest } = data;
  return rest;
}

/** A seeded file may carry only `content` (text); an upload carries its bytes. */
function bytesOfFile(data: Record<string, unknown>): Buffer {
  if (typeof data.contentBase64 === 'string') return Buffer.from(data.contentBase64, 'base64');
  return Buffer.from(String(data.content ?? ''), 'utf8');
}

function textOf(bytes: Buffer): string | null {
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/** One part of a multipart body: its `Content-Type`, when it names one. */
interface Part {
  contentType?: string;
  body: Buffer;
}

/** One multipart body split on its boundary as BYTES: a binary part decoded
 *  to a string and back is no longer the file that was sent. */
function multipartBodies(raw: Buffer, boundary: string): Part[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const bodies: Part[] = [];
  let at = raw.indexOf(delimiter);
  while (at >= 0) {
    const start = at + delimiter.length;
    const next = raw.indexOf(delimiter, start);
    if (next < 0) break;
    const part = raw.subarray(start, next);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd >= 0) {
      const body = part.subarray(headEnd + 4);
      const contentType = /^content-type:\s*(.+)$/im.exec(part.subarray(0, headEnd).toString('utf8'))?.[1]?.trim();
      // The CRLF before the next delimiter belongs to the delimiter.
      const trimmed = body.subarray(0, body.length - (body.subarray(-2).toString() === '\r\n' ? 2 : 0));
      bodies.push({ ...(contentType ? { contentType } : {}), body: trimmed });
    }
    at = next;
  }
  return bodies;
}

/** Parse the exact `q` patterns the api client composes. */
function matchesQuery(data: Record<string, unknown>, q: string): boolean {
  const parent = /'((?:[^'\\]|\\')*)' in parents/.exec(q)?.[1]?.replace(/\\'/g, "'");
  if (parent !== undefined) {
    const parents = (data.parents ?? []) as string[];
    if (!parents.includes(parent)) return false;
  }
  const name = /name = '((?:[^'\\]|\\')*)'/.exec(q)?.[1]?.replace(/\\'/g, "'");
  if (name !== undefined && data.name !== name) return false;
  const mimeEq = /mimeType = '([^']*)'/.exec(q)?.[1];
  if (mimeEq !== undefined && data.mimeType !== mimeEq) return false;
  const mimeNeq = /mimeType != '([^']*)'/.exec(q)?.[1];
  if (mimeNeq !== undefined && data.mimeType === mimeNeq) return false;
  if (/trashed = false/.test(q) && data.trashed === true) return false;
  return true;
}

export function gdriveRoutes(store: EntityStore): Router {
  const r = Router();

  r.get('/drive/v3/files', (req, res) => {
    const q = String(req.query.q ?? '');
    const files = store
      .list(SVC, 'file')
      .filter((f) => matchesQuery(f.data, q))
      .map((f) => fileOut(f.data));
    res.json({ files });
  });

  // Metadata-only create (folders).
  r.post('/drive/v3/files', (req, res) => {
    const id = store.nextId(SVC, 'file');
    const entity = store.create(
      SVC,
      'file',
      {
        id,
        name: req.body.name ?? 'Untitled',
        mimeType: req.body.mimeType ?? FOLDER_MIME,
        parents: req.body.parents ?? ['root'],
        webViewLink: `https://drive.google.com/drive/folders/${id}`,
        content: null,
        size: null,
      },
      id,
    );
    res.json(fileOut(entity.data));
  });

  // Multipart create (documents / uploads): part 1 = JSON metadata,
  // part 2 = the content bytes.
  const rawBody = express.raw({ type: '*/*', limit: '50mb' });
  r.post('/upload/drive/v3/files', rawBody, (req, res) => {
    const contentType = String(req.headers['content-type'] ?? '');
    const boundary = /boundary=([^;]+)/.exec(contentType)?.[1]?.replace(/^"|"$/g, '');
    if (!boundary) return res.status(400).json({ error: 'missing multipart boundary' });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8');
    const parts = multipartBodies(raw, boundary);
    if (parts.length < 2) return res.status(400).json({ error: 'expected two multipart parts' });
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(parts[0].body.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'part 1 is not JSON metadata' });
    }
    const { body: bytes, contentType: mediaType } = parts[1];
    const id = store.nextId(SVC, 'file');
    const entity = store.create(
      SVC,
      'file',
      {
        id,
        name: (metadata.name as string) ?? 'Untitled',
        // As real Drive: the metadata's type, else the media part's.
        mimeType: (metadata.mimeType as string | undefined) ?? mediaType ?? 'application/octet-stream',
        parents: (metadata.parents as string[]) ?? ['root'],
        webViewLink: `https://drive.google.com/file/d/${id}`,
        content: textOf(bytes),
        contentBase64: bytes.toString('base64'),
        size: bytes.length,
        md5Checksum: createHash('md5').update(bytes).digest('hex'),
        sha256Checksum: createHash('sha256').update(bytes).digest('hex'),
      },
      id,
    );
    res.json(fileOut(entity.data));
  });

  r.get('/drive/v3/files/:id', (req, res) => {
    const file = store.get(SVC, 'file', req.params.id);
    if (!file) return res.status(404).json({ error: 'not found' });
    if (req.query.alt === 'media') {
      res.setHeader(
        'Content-Type',
        (file.data.mimeType as string) === FOLDER_MIME
          ? 'application/octet-stream'
          : (file.data.mimeType as string) || 'application/octet-stream',
      );
      return res.send(bytesOfFile(file.data));
    }
    res.json(fileOut(file.data));
  });

  // files.copy: the copy lands in `parents` (the source's own when none are
  // given), named `name` (or "Copy of <source>"). A source or destination
  // folder outside the grant is a 404, as under drive.file. The copy is the
  // app's own, so it is granted. It carries the source's bytes and checksums.
  r.post('/drive/v3/files/:id/copy', (req, res) => {
    const notFound = (id: string) => res.status(404).json({ error: { code: 404, message: `File not found: ${id}.` } });
    const source = store.get(SVC, 'file', req.params.id);
    if (!source || source.data.granted === false) return notFound(req.params.id);
    const parents = (req.body?.parents as string[] | undefined) ?? (source.data.parents as string[]);
    for (const parent of parents) {
      const folder = store.get(SVC, 'file', parent);
      if (parent !== 'root' && (!folder || folder.data.granted === false)) return notFound(parent);
    }
    const id = store.nextId(SVC, 'file');
    const entity = store.create(
      SVC,
      'file',
      {
        ...source.data,
        id,
        name: req.body?.name ?? `Copy of ${String(source.data.name)}`,
        parents,
        webViewLink: `https://drive.google.com/file/d/${id}`,
      },
      id,
    );
    res.json(fileOut(entity.data));
  });

  return r;
}
