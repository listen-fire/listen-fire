import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { EntityStore } from '../../store';
import { gdriveRoutes } from '../gdrive';

async function bootApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const store = new EntityStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gdrive-test-')), 'fake-channels.db'));
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', gdriveRoutes(store));
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

test('gdrive upload: a binary file is stored and served back byte for byte', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x0d, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x0d, 0x0a]);
    const boundary = 'b0undary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(JSON.stringify({ name: 'invoice.pdf', mimeType: 'application/pdf', parents: ['fold-x'] })),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const created = (await (
      await fetch(`${baseUrl}/upload/drive/v3/files?uploadType=multipart`, {
        method: 'POST',
        headers: { 'content-type': `multipart/related; boundary=${boundary}` },
        body,
      })
    ).json()) as { id: string; size: number; md5Checksum: string };
    assert.equal(created.size, bytes.length);
    assert.equal(created.md5Checksum, createHash('md5').update(bytes).digest('hex'));
    const served = Buffer.from(await (await fetch(`${baseUrl}/drive/v3/files/${created.id}?alt=media`)).arrayBuffer());
    assert.ok(served.equals(bytes));
  } finally {
    await close();
  }
});

test('gdrive copy: the copy holds the source\'s bytes and checksums', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80]);
    const boundary = 'b0undary';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
      Buffer.from(JSON.stringify({ name: 'invoice.pdf', mimeType: 'application/pdf' })),
      Buffer.from(`\r\n--${boundary}\r\nContent-Type: application/pdf\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const source = (await (
      await fetch(`${baseUrl}/upload/drive/v3/files?uploadType=multipart`, { method: 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body })
    ).json()) as { id: string; md5Checksum: string; sha256Checksum: string };
    const copy = (await (
      await fetch(`${baseUrl}/drive/v3/files/${source.id}/copy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'copy.pdf' }) })
    ).json()) as { id: string; size: number; md5Checksum: string; sha256Checksum: string; contentBase64?: string };
    assert.notEqual(copy.id, source.id);
    assert.equal(copy.size, bytes.length);
    assert.equal(copy.md5Checksum, source.md5Checksum);
    assert.equal(copy.sha256Checksum, source.sha256Checksum);
    assert.equal(copy.contentBase64, undefined, 'the bytes are served by alt=media, not in the metadata');
    const served = Buffer.from(await (await fetch(`${baseUrl}/drive/v3/files/${copy.id}?alt=media`)).arrayBuffer());
    assert.ok(served.equals(bytes));
  } finally {
    await close();
  }
});
