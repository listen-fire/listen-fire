// Unit tests for the Google Drive TG adapter — pure helpers + mocked-client
// paths only (no network, no LLM). Covers:
//   1. type-id codec (folder/document/upload kinds) + rejection of
//      foreign/malformed ids.
//   2. describe — field mapping for each write type; null for foreign ids.
//   3. createRecord — folder (create + by-name reuse), document (writes
//      PROVIDED content, NO LLM), upload (inline + objectUri), honouring
//      parentLink / `parent` field. Throws on unrecognised recordType.
//   4. create-only updateRecord / deleteRecord throw.
//   5. resolveEntity — bridge-only (linked_object dedup, else 0 candidates).
//
// The Drive client is a fake the adapter is constructed with; fake-channels
// is never hit. A handed file's bytes come from a fake reader.

import { Readable } from 'node:stream';

import type { ModuleLog } from 'module-kit';
import type {
  ResolveEntityInput,
  WriteInput,
  UpdateInput,
  DeleteInput,
} from 'movement-engine/public/adapter';

import { refusingKv } from 'module-kit';
import { GoogleDriveAdapter } from '../adapter';
import { GoogleDriveClient } from '../drive_client';
import {
  DISPLAY_NAME_BY_KIND,
  structuredIdFor,
  requireStructuredId,
  driveUrl,
} from '../types';

// The pretty type names are the framework identity — a position's
// `recordType` / an entry's `typeId`. No system prefix (rule 5): the
// instance already says which system you're in.
const FOLDER_TYPE = DISPLAY_NAME_BY_KIND.folder;
const FILE_TYPE = DISPLAY_NAME_BY_KIND.file;

// ---------------------------------------------------------------------------
// Fixtures + fake client
// ---------------------------------------------------------------------------

const PARENT_FOLDER = 'fldrPARENT01';

const quiet: ModuleLog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** The bytes the host holds for a handed file, by its name. */
const handedFiles = new Map<string, string>([['report.pdf', 'file-bytes']]);

interface FakeClientCalls {
  findFolder: Array<{ name: string; parentId: string }>;
  createFolder: Array<{ name: string; parentId: string }>;
  createDocument: Array<{ name: string; content: string; parentId: string }>;
  uploadFile: Array<{ name: string; parentId: string; mimeType?: string; body: string }>;
  copyFile: Array<{ fileId: string; name?: string; parentId: string }>;
}

function makeAdapter(options?: { existingFolderId?: string; copyError?: Error }): {
  adapter: GoogleDriveAdapter;
  calls: FakeClientCalls;
} {
  const adapter = new GoogleDriveAdapter({
    client: async () => fakeClient as unknown as GoogleDriveClient,
    kv: refusingKv('no grants in these tests'),
    readFile: async (ref) => {
      const bytes = handedFiles.get(ref.name ?? '');
      if (bytes === undefined) throw new Error(`no bytes for ${ref.name ?? 'an unnamed file'}`);
      return new Uint8Array(Buffer.from(bytes));
    },
    log: quiet,
  });
  const calls: FakeClientCalls = {
    findFolder: [],
    createFolder: [],
    createDocument: [],
    uploadFile: [],
    copyFile: [],
  };
  const fakeClient = {
    findFolder: async (args: { name: string; parentId: string }) => {
      calls.findFolder.push(args);
      return options?.existingFolderId ?? null;
    },
    createFolder: async (args: { name: string; parentId: string }) => {
      calls.createFolder.push(args);
      return { id: 'fldrNEW01', webViewLink: 'https://drive.google.com/drive/folders/fldrNEW01' };
    },
    createDocument: async (args: { name: string; content: string; parentId: string }) => {
      calls.createDocument.push(args);
      return { id: 'docNEW01', webViewLink: 'https://docs.google.com/document/d/docNEW01' };
    },
    uploadFile: async (args: { name: string; parentId: string; stream: Readable; mimeType?: string }) => {
      const body = await streamToString(args.stream);
      calls.uploadFile.push({ name: args.name, parentId: args.parentId, mimeType: args.mimeType, body });
      return { id: 'fileNEW01', webViewLink: 'https://drive.google.com/file/d/fileNEW01' };
    },
    copyFile: async (args: { fileId: string; name?: string; parentId: string }) => {
      calls.copyFile.push(args);
      if (options?.copyError) throw options.copyError;
      return {
        id: 'copyNEW01',
        name: args.name ?? 'Copy of template',
        mimeType: 'application/vnd.google-apps.document',
        webViewLink: 'https://docs.google.com/document/d/copyNEW01',
        size: null,
      };
    },
  };
  return { adapter, calls };
}

async function streamToString(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// 1. Type-id codec
// ---------------------------------------------------------------------------

describe('Google Drive name → kind map', () => {
  it('maps each pretty type name to its kind (no system prefix — rule 5)', () => {
    expect(FOLDER_TYPE).toBe('Folder');
    expect(FILE_TYPE).toBe('File');
    expect(structuredIdFor(FOLDER_TYPE)).toBe('folder');
    expect(structuredIdFor(FILE_TYPE)).toBe('file');
  });

  it('returns undefined for an unknown / foreign / retired name', () => {
    expect(structuredIdFor('google-drive:folder')).toBeUndefined();
    expect(structuredIdFor('Sheet1 (table)')).toBeUndefined();
    // The old system-prefixed names and merged write forms are GONE.
    expect(structuredIdFor('Drive Folder')).toBeUndefined();
    expect(structuredIdFor('Drive Document')).toBeUndefined();
    expect(structuredIdFor('Drive Upload')).toBeUndefined();
    expect(structuredIdFor('Drive File')).toBeUndefined();
    expect(structuredIdFor('bogus')).toBeUndefined();
  });

  it('requireStructuredId throws on an unknown name', () => {
    expect(() => requireStructuredId('nope', 'createRecord')).toThrow(
      /unrecognised recordType/,
    );
  });

  it('driveUrl builds folder vs file urls', () => {
    expect(driveUrl('abc', 'folder')).toBe('https://drive.google.com/drive/folders/abc');
    expect(driveUrl('abc', 'file')).toBe('https://drive.google.com/file/d/abc');
  });
});

// ---------------------------------------------------------------------------
// 2. listEntryPoints + describe
// ---------------------------------------------------------------------------

describe('GoogleDriveAdapter schema introspection', () => {
  it('lists the two nouns, readable at the root but NOT root-writable (rule 0 — creates live on the folder edges)', async () => {
    const { adapter } = makeAdapter();
    const entries = await adapter.listEntryPoints();
    const byId = new Map(entries.map((e) => [e.typeId, e]));
    expect(byId.size).toBe(2);
    expect(byId.get(FOLDER_TYPE)).toMatchObject({
      writable: false,
      readable: true,
      collectionName: 'Folders',
    });
    expect(byId.get(FILE_TYPE)).toMatchObject({
      writable: false,
      readable: true,
      collectionName: 'Files',
    });
  });

  it('describes Folder — Name required, writable child edges (rule 6), no parent pin field', async () => {
    const { adapter } = makeAdapter();
    const descriptor = await adapter.describe(FOLDER_TYPE);
    expect(descriptor).not.toBeNull();
    const byId = new Map(descriptor!.fields.map((f) => [f.fieldId, f]));
    expect(byId.get('name')!.required).toBe(true);
    expect(byId.get('name')!.displayName).toBe('Name');
    expect(byId.get('parent')).toBeUndefined();
    const refs = new Map(descriptor!.references.map((r) => [r.name, r]));
    expect([...refs.keys()]).toEqual(['Folders', 'Files']);
    expect(refs.get('Folders')!.writable).toBe(true);
    expect(refs.get('Files')!.writable).toBe(true);
  });

  it('describes File — one File field (bytes both ways) plus write-only Content (Google Doc import)', async () => {
    const { adapter } = makeAdapter();
    const file = await adapter.describe(FILE_TYPE);
    const fields = new Map(file!.fields.map((f) => [f.fieldId, f]));
    expect(fields.get('file')!.kind).toBe('file');
    expect(fields.get('file')!.writable).toBe(true);
    expect(fields.get('file')!.readable).not.toBe(false); // read side: the content FileRef
    expect(fields.get('content')!.kind).toBe('string');
    expect(fields.get('content')!.writable).toBe(true);
    expect(fields.get('content')!.readable).toBe(false); // no Doc-text read-back today
    expect(fields.get('name')!.required).toBe(false);
    expect(fields.get('id')!.writable).toBe(false);
    expect(fields.get('mimeType')!.writable).toBe(false);
    expect(file!.references.map((r) => [r.name, r.targetTypeId, r.writable])).toEqual([['Copies', FILE_TYPE, true]]);
  });

  it('returns null for a foreign / unknown / retired typeId', async () => {
    const { adapter } = makeAdapter();
    expect(await adapter.describe('google-sheets:x:sheet:1')).toBeNull();
    expect(await adapter.describe('Drive Document')).toBeNull();
    expect(await adapter.describe('Drive Upload')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. createRecord — write paths
// ---------------------------------------------------------------------------

describe('GoogleDriveAdapter.createRecord — folder', () => {
  it('creates a new folder when none exists, using parentLink', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: FOLDER_TYPE,
      fields: { name: 'Acme Corp' },
      mutationContext: {} as never,
      parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'contains' }],
    } as WriteInput);

    expect(calls.findFolder).toEqual([{ name: 'Acme Corp', parentId: PARENT_FOLDER }]);
    expect(calls.createFolder).toEqual([{ name: 'Acme Corp', parentId: PARENT_FOLDER }]);
    expect(result.externalId).toBe('fldrNEW01');
    expect(result.data).toMatchObject({ Id: 'fldrNEW01', Name: 'Acme Corp' });
    expect(result.data!.Url).toBe('https://drive.google.com/drive/folders/fldrNEW01');
  });

  it('reuses an existing folder found by name (tier-1), skipping create', async () => {
    const { adapter, calls } = makeAdapter({ existingFolderId: 'fldrEXIST01' });
    const result = await adapter.createRecord({
      recordType: FOLDER_TYPE,
      fields: { name: 'Acme Corp', parent: PARENT_FOLDER },
      mutationContext: {} as never,
    } as WriteInput);

    expect(calls.findFolder).toHaveLength(1);
    expect(calls.createFolder).toHaveLength(0);
    expect(result.externalId).toBe('fldrEXIST01');
  });

  it('uses the `parent` field when there is no parentLink (root action)', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: FOLDER_TYPE,
      fields: { name: 'Root', parent: 'fldrROOTCFG' },
      mutationContext: {} as never,
    } as WriteInput);
    expect(calls.findFolder[0].parentId).toBe('fldrROOTCFG');
  });

  it('throws when no parent folder is available — under drive.file every create names a real parent', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: FOLDER_TYPE,
        fields: { name: 'Orphan' },
        mutationContext: {} as never,
      } as WriteInput),
    ).rejects.toThrow(/no parent folder/);
  });
});

describe('GoogleDriveAdapter.createRecord — file (one noun, two byte channels)', () => {
  it('Content imports text as a Google Doc, verbatim (no LLM)', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: { name: 'Memo', content: 'Body produced by the TG body.' },
      mutationContext: {} as never,
      parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' }],
    } as WriteInput);

    expect(calls.createDocument).toEqual([
      { name: 'Memo', content: 'Body produced by the TG body.', parentId: PARENT_FOLDER },
    ]);
    expect(calls.uploadFile).toHaveLength(0);
    expect(result.externalId).toBe('docNEW01');
  });

  it('File uploads inline text as-is', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: { name: 'notes.txt', file: 'hello world' },
      mutationContext: {} as never,
      parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' }],
    } as WriteInput);

    expect(calls.uploadFile).toHaveLength(1);
    expect(calls.uploadFile[0].name).toBe('notes.txt');
    expect(calls.uploadFile[0].parentId).toBe(PARENT_FOLDER);
    expect(calls.uploadFile[0].body).toBe('hello world');
    expect(calls.createDocument).toHaveLength(0);
    expect(result.externalId).toBe('fileNEW01');
  });

  it('File streams the bytes its descriptor is redeemed for', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: {
        file: { __brand: 'FileRef', name: 'report.pdf', contentType: 'application/pdf', source: { store: 'document', objectUri: 'mem://report' } },
      },
      mutationContext: {} as never,
      parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' }],
    } as WriteInput);

    expect(calls.uploadFile[0].name).toBe('report.pdf');
    expect(calls.uploadFile[0].mimeType).toBe('application/pdf');
    expect(calls.uploadFile[0].body).toBe('file-bytes');
  });

  it('throws LOUDLY when both Content and File are set — one value must not mean two facts', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: FILE_TYPE,
        fields: { name: 'x', content: 'text', file: 'bytes' },
        mutationContext: {} as never,
        parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' }],
      } as WriteInput),
    ).rejects.toThrow(/both `Content` and `File`/);
  });

  it('throws LOUDLY when neither Content nor File is set', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: FILE_TYPE,
        fields: { name: 'x' },
        mutationContext: {} as never,
        parentLinks: [{ recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' }],
      } as WriteInput),
    ).rejects.toThrow(/neither `Content` nor `File`/);
  });

  it('throws when no parent folder is available', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: FILE_TYPE,
        fields: { name: 'x', file: 'bytes' },
        mutationContext: {} as never,
      } as WriteInput),
    ).rejects.toThrow(/no parent folder/);
  });
});

describe('GoogleDriveAdapter.createRecord — copy (a file written along two edges)', () => {
  const links = [
    { recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' },
    { recordType: FILE_TYPE, externalId: 'docTEMPLATE', edgeName: 'Copies' },
  ];

  it('copies the source into the folder under the new name and returns the new file', async () => {
    const { adapter, calls } = makeAdapter();
    const result = await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: { name: 'Acme brief' },
      mutationContext: {} as never,
      parentLinks: links,
    } as WriteInput);

    expect(calls.copyFile).toEqual([{ fileId: 'docTEMPLATE', name: 'Acme brief', parentId: PARENT_FOLDER }]);
    expect(calls.createDocument).toHaveLength(0);
    expect(calls.uploadFile).toHaveLength(0);
    expect(result.externalId).toBe('copyNEW01');
    expect(result.data).toMatchObject({ Id: 'copyNEW01', Name: 'Acme brief', 'Mime Type': 'application/vnd.google-apps.document', Url: 'https://docs.google.com/document/d/copyNEW01' });
  });

  it('is order-independent and lets Drive name the copy when no Name is given', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: {},
      mutationContext: {} as never,
      parentLinks: [...links].reverse(),
    } as WriteInput);
    expect(calls.copyFile).toEqual([{ fileId: 'docTEMPLATE', name: undefined, parentId: PARENT_FOLDER }]);
  });

  it('the copy is a normal file: a later write can name it as a parent', async () => {
    const { adapter, calls } = makeAdapter();
    const copy = await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: { name: 'Acme brief' },
      mutationContext: {} as never,
      parentLinks: links,
    } as WriteInput);
    await adapter.createRecord({
      recordType: FILE_TYPE,
      fields: { name: 'Acme brief v2' },
      mutationContext: {} as never,
      parentLinks: [
        { recordType: FOLDER_TYPE, externalId: PARENT_FOLDER, edgeName: 'Files' },
        { recordType: FILE_TYPE, externalId: copy.externalId, edgeName: 'Copies', data: copy.data },
      ],
    } as WriteInput);
    expect(calls.copyFile[1].fileId).toBe('copyNEW01');
  });

  it('refuses a copy with no folder, and a copy that also carries Content or File', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.createRecord({
        recordType: FILE_TYPE,
        fields: { name: 'x' },
        mutationContext: {} as never,
        parentLinks: [links[1]],
      } as WriteInput),
    ).rejects.toThrow(/no parent folder/);
    await expect(
      adapter.createRecord({
        recordType: FILE_TYPE,
        fields: { name: 'x', content: 'text' },
        mutationContext: {} as never,
        parentLinks: links,
      } as WriteInput),
    ).rejects.toThrow(/copy.*`Content`/is);
  });

  it('says plainly when Drive refuses the source because the app was not granted it', async () => {
    const { adapter } = makeAdapter({ copyError: Object.assign(new Error('File not found: docTEMPLATE.'), { code: 404 }) });
    await expect(
      adapter.createRecord({
        recordType: FILE_TYPE,
        fields: { name: 'x' },
        mutationContext: {} as never,
        parentLinks: links,
      } as WriteInput),
    ).rejects.toThrow(/cannot copy docTEMPLATE.*not granted/i);
  });
});

describe('GoogleDriveClient.copyFile over a fake Drive (files.copy)', () => {
  // A Drive that knows two granted files and one folder, answers only what
  // drive.file would, and records what it was asked.
  function fakeDrive() {
    const requests: Array<{ method: string; path: string; body: unknown }> = [];
    const granted = new Set(['docTEMPLATE', 'fldrDEST']);
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url.pathname, body });
      const match = /^\/drive\/v3\/files\/([^/]+)\/copy$/.exec(url.pathname);
      const json = (status: number, payload: unknown) =>
        new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
      if (method !== 'POST' || !match) return json(400, { error: { code: 400, message: 'unexpected' } });
      const [, fileId] = match;
      if (!granted.has(fileId) || !granted.has(body.parents?.[0])) {
        return json(404, { error: { code: 404, message: `File not found: ${fileId}.` } });
      }
      return json(200, { id: 'copyNEW01', name: body.name ?? 'Copy of template', mimeType: 'application/vnd.google-apps.document', webViewLink: 'https://docs.google.com/document/d/copyNEW01' });
    };
    return { requests, fetchImpl };
  }

  it('POSTs /drive/v3/files/{id}/copy with the name and parent and returns the new file', async () => {
    const { requests, fetchImpl } = fakeDrive();
    const client = new GoogleDriveClient({ accessToken: async () => 't', fetch: fetchImpl });
    const copy = await client.copyFile({ fileId: 'docTEMPLATE', name: 'Acme brief', parentId: 'fldrDEST' });
    expect(requests).toEqual([
      { method: 'POST', path: '/drive/v3/files/docTEMPLATE/copy', body: { name: 'Acme brief', parents: ['fldrDEST'] } },
    ]);
    expect(copy).toMatchObject({ id: 'copyNEW01', name: 'Acme brief' });
  });

  it('is refused for a file the app was not granted', async () => {
    const { fetchImpl } = fakeDrive();
    const client = new GoogleDriveClient({ accessToken: async () => 't', fetch: fetchImpl });
    await expect(client.copyFile({ fileId: 'docSTRANGER', parentId: 'fldrDEST' })).rejects.toMatchObject({ code: 404 });
  });
});

describe('GoogleDriveAdapter.createRecord — dispatch', () => {
  it('throws on an unrecognised / retired recordType', async () => {
    const { adapter } = makeAdapter();
    for (const recordType of ['google-sheets:x:sheet:1', 'Drive Document', 'Drive Upload']) {
      await expect(
        adapter.createRecord({
          recordType,
          fields: {},
          mutationContext: {} as never,
        } as WriteInput),
      ).rejects.toThrow(/unrecognised recordType/);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. create-only update / delete throw
// ---------------------------------------------------------------------------

describe('GoogleDriveAdapter create-only writes', () => {
  it('updateRecord throws a create-only error', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.updateRecord({
        recordType: FOLDER_TYPE,
        externalId: 'whatever',
        fields: {},
        mutationContext: {} as never,
      } as UpdateInput),
    ).rejects.toThrow(/create-only/);
  });

  it('deleteRecord throws a create-only error', async () => {
    const { adapter } = makeAdapter();
    await expect(
      adapter.deleteRecord({
        recordType: FOLDER_TYPE,
        externalId: 'whatever',
        mutationContext: {} as never,
      } as DeleteInput),
    ).rejects.toThrow(/create-only/);
  });
});

// ---------------------------------------------------------------------------
// 5. resolveEntity — bridge-only
// ---------------------------------------------------------------------------

describe('GoogleDriveAdapter.resolveEntity', () => {
  it('returns 0 candidates with no prior bridge (engine creates fresh)', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.resolveEntity({
      record: { name: 'Acme' },
      recordType: FOLDER_TYPE,
      candidates: [],
      constraints: [],
    } as unknown as ResolveEntityInput);
    expect(result.candidates).toEqual([]);
  });

  it('returns 0 candidates EVEN WITH a prior bridge — Drive is create-only, so a candidate would route the engine into updateRecord (which throws)', async () => {
    const { adapter } = makeAdapter();
    const result = await adapter.resolveEntity({
      record: { name: 'Acme' },
      recordType: FOLDER_TYPE,
      candidates: [
        {
          node_id: 'node-1',
          external_id: 'fldrEXIST01',
          external_object_type: FOLDER_TYPE,
          created_at: new Date(),
        } as unknown as ResolveEntityInput['candidates'][number],
      ],
      constraints: [],
    } as unknown as ResolveEntityInput);
    expect(result.candidates).toEqual([]);
  });
});
