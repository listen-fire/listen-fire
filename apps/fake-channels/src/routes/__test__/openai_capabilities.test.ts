import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { openAiRoutes } from '../openai';
import { FAKE_PNG_BASE64, FAKE_TRANSCRIPT } from '../openai_capabilities';

/**
 * Route-level tests for the fake OpenAI's transcription, embeddings and image
 * endpoints, mounted as the fake-channels app mounts them (JSON parser first,
 * so a multipart body reaching the transcription route proves it reads its
 * own).
 */

async function bootApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use('/openai/v1', openAiRoutes());
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}/openai/v1`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const AUTH = { authorization: 'Bearer sk-test' };

async function postJson(url: string, body: unknown, headers: Record<string, string> = AUTH) {
  return fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function audioForm(filename: string, fields: Record<string, string>): FormData {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from('RIFF\0\0\0\0WAVEfmt ')], { type: 'audio/wav' }), filename);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return form;
}

test('transcription: multipart in, verbose_json out', async () => {
  const app = await bootApp();
  try {
    const res = await fetch(`${app.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: AUTH,
      body: audioForm('note.wav', { model: 'whisper-1', response_format: 'verbose_json' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.text, FAKE_TRANSCRIPT);
    assert.equal(typeof body.duration, 'number');
  } finally {
    await app.close();
  }
});

test('transcription: refuses what OpenAI refuses', async () => {
  const app = await bootApp();
  try {
    const noExtension = await fetch(`${app.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: AUTH,
      body: audioForm('wamid.HBgM', { model: 'whisper-1' }),
    });
    assert.equal(noExtension.status, 400);
    assert.match((await noExtension.json()).error.message, /Invalid file format/);

    const noModel = await fetch(`${app.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: AUTH,
      body: audioForm('note.wav', {}),
    });
    assert.equal(noModel.status, 400);

    const unknownField = await fetch(`${app.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: AUTH,
      body: audioForm('note.wav', { model: 'whisper-1', colour: 'blue' }),
    });
    assert.equal(unknownField.status, 400);

    const noKey = await fetch(`${app.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      body: audioForm('note.wav', { model: 'whisper-1' }),
    });
    assert.equal(noKey.status, 401);
  } finally {
    await app.close();
  }
});

test('embeddings: unit vectors at the native or requested width, floats or base64', async () => {
  const app = await bootApp();
  try {
    const native = await (await postJson(`${app.baseUrl}/embeddings`, { model: 'text-embedding-3-large', input: ['a', 'b'] })).json();
    assert.equal(native.data.length, 2);
    assert.equal(native.data[0].embedding.length, 3072);
    const magnitude = Math.sqrt(native.data[0].embedding.reduce((s: number, v: number) => s + v * v, 0));
    assert.ok(Math.abs(magnitude - 1) < 1e-9);

    const short = await (
      await postJson(`${app.baseUrl}/embeddings`, {
        model: 'text-embedding-3-small',
        input: 'a',
        dimensions: 256,
        encoding_format: 'base64',
      })
    ).json();
    const bytes = Buffer.from(short.data[0].embedding, 'base64');
    const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
    assert.equal(floats.length, 256);
  } finally {
    await app.close();
  }
});

test('embeddings: refuses a width the model cannot produce, and a model that does not exist', async () => {
  const app = await bootApp();
  try {
    const tooWide = await postJson(`${app.baseUrl}/embeddings`, { model: 'text-embedding-3-small', input: 'a', dimensions: 3072 });
    assert.equal(tooWide.status, 400);
    const unknown = await postJson(`${app.baseUrl}/embeddings`, { model: 'text-embedding-9', input: 'a' });
    assert.equal(unknown.status, 404);
    const stray = await postJson(`${app.baseUrl}/embeddings`, { model: 'text-embedding-3-small', input: 'a', extra: 1 });
    assert.equal(stray.status, 400);
  } finally {
    await app.close();
  }
});

test('images: a 1×1 PNG as base64, and DALL·E 3’s own refusals', async () => {
  const app = await bootApp();
  try {
    const ok = await postJson(`${app.baseUrl}/images/generations`, {
      model: 'dall-e-3',
      prompt: 'a leaf',
      n: 1,
      size: '1792x1024',
      quality: 'hd',
      style: 'natural',
      response_format: 'b64_json',
    });
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).data[0].b64_json, FAKE_PNG_BASE64);

    const badSize = await postJson(`${app.baseUrl}/images/generations`, { model: 'dall-e-3', prompt: 'a leaf', size: '640x480' });
    assert.equal(badSize.status, 400);
    const two = await postJson(`${app.baseUrl}/images/generations`, { model: 'dall-e-3', prompt: 'a leaf', n: 2 });
    assert.equal(two.status, 400);
  } finally {
    await app.close();
  }
});
