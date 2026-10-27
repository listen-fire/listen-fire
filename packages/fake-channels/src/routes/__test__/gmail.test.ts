import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { EntityStore } from '../../store';
import { gmailRoutes } from '../gmail';

/**
 * Route-level tests for the fake Gmail's SEND, run via `node --test` (through
 * `tsx --test`, no jest in this package — see package.json).
 *
 * The point of these is that the fake reads a real RFC 2822 message: it is
 * handed one base64url blob and has to find the subject, the recipients, the
 * body and the reply headers in it. A fake that stored the blob and answered
 * questions about the request instead would pass while the adapter's MIME
 * builder produced something no mail client could read.
 */

async function bootApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-test-')),
    'fake-channels.db',
  );
  const store = new EntityStore(dbPath);

  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/', gmailRoutes(store));

  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const CRLF = '\r\n';

function raw(lines: string[]): string {
  return Buffer.from(lines.join(CRLF), 'utf8').toString('base64url');
}

async function send(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${baseUrl}/gmail/v1/users/me/messages/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

async function state(baseUrl: string): Promise<{
  messages: Record<string, unknown>[];
  outbox: Record<string, unknown>[];
}> {
  const res = await fetch(`${baseUrl}/fake-gmail/state`);
  return (await res.json()) as { messages: Record<string, unknown>[]; outbox: Record<string, unknown>[] };
}

test('gmail send: a plain message lands in the outbox with its headers read back', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const { json } = await send(baseUrl, {
      raw: raw([
        'From: deals@example.com',
        'To: rita@northwind.example',
        'Cc: books@example.com',
        'Subject: Quarterly figures',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Attached, as promised.', 'utf8').toString('base64'),
      ]),
    });
    assert.equal(typeof json.id, 'string');
    assert.equal(json.threadId, json.id, 'new mail starts its own conversation');
    assert.deepEqual(json.labelIds, ['SENT']);

    const { outbox } = await state(baseUrl);
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].subject, 'Quarterly figures');
    assert.equal(outbox[0].to, 'rita@northwind.example');
    assert.equal(outbox[0].cc, 'books@example.com');
    assert.equal(outbox[0].body, 'Attached, as promised.');
    assert.equal(outbox[0].inReplyTo, null);
  } finally {
    await close();
  }
});

test('gmail send: a reply keeps the thread it was given and its reply headers', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const { json } = await send(baseUrl, {
      threadId: 'thread-7',
      raw: raw([
        'From: deals@example.com',
        'To: rita@northwind.example',
        'Subject: Re: Quarterly figures',
        'In-Reply-To: <parent@northwind.example>',
        'References: <first@northwind.example> <parent@northwind.example>',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Got it.', 'utf8').toString('base64'),
      ]),
    });
    assert.equal(json.threadId, 'thread-7');

    const { outbox } = await state(baseUrl);
    assert.equal(outbox[0].threadId, 'thread-7');
    assert.equal(outbox[0].inReplyTo, '<parent@northwind.example>');
    assert.equal(outbox[0].references, '<first@northwind.example> <parent@northwind.example>');
    assert.equal(outbox[0].subject, 'Re: Quarterly figures');
  } finally {
    await close();
  }
});

test('gmail send: a multipart message yields its text body and its files', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    await send(baseUrl, {
      raw: raw([
        'From: deals@example.com',
        'To: rita@northwind.example',
        'Subject: With a file',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="B2"',
        '',
        '--B2',
        'Content-Type: multipart/alternative; boundary="B1"',
        '',
        '--B1',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Plain words.', 'utf8').toString('base64'),
        '--B1',
        'Content-Type: text/html; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('<p>Rich words.</p>', 'utf8').toString('base64'),
        '--B1--',
        '--B2',
        'Content-Type: text/csv; name="figures.csv"',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="figures.csv"',
        '',
        Buffer.from('period,revenue', 'utf8').toString('base64'),
        '--B2--',
      ]),
    });

    const { outbox } = await state(baseUrl);
    assert.equal(outbox[0].body, 'Plain words.');
    assert.deepEqual(outbox[0].attachments, [`${outbox[0].id}-att-1`]);
  } finally {
    await close();
  }
});

test('gmail send: sent mail reads back by id and never shows up as inbox mail', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const { json } = await send(baseUrl, {
      raw: raw([
        'From: deals@example.com',
        'To: rita@northwind.example',
        'Subject: Readable back',
        'Content-Type: text/plain; charset="UTF-8"',
        'Content-Transfer-Encoding: base64',
        '',
        Buffer.from('Hello.', 'utf8').toString('base64'),
      ]),
    });

    const fetched = await fetch(`${baseUrl}/gmail/v1/users/me/messages/${String(json.id)}`);
    const message = (await fetched.json()) as { id: string; labelIds: string[] };
    assert.equal(message.id, json.id);
    assert.deepEqual(message.labelIds, ['SENT']);

    // The INBOX-scoped poll must never deliver the mailbox its own outgoing mail.
    const history = await fetch(
      `${baseUrl}/gmail/v1/users/me/history?startHistoryId=1&labelId=INBOX`,
    );
    const page = (await history.json()) as { history: unknown[] };
    assert.deepEqual(page.history, []);

    const { messages } = await state(baseUrl);
    assert.deepEqual(messages, []);
  } finally {
    await close();
  }
});

test('gmail send: a request with no message is refused', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const { status } = await send(baseUrl, {});
    assert.equal(status, 400);
  } finally {
    await close();
  }
});

test("gmail list: an unsupported search is refused with a 400 naming it, not matched to nothing", async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const res = await fetch(`${baseUrl}/gmail/v1/users/me/messages?q=${encodeURIComponent("larger:5M")}`);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /unsupported operator "larger:"/);
  } finally {
    await close();
  }
});

async function post(baseUrl: string, route: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

async function history(baseUrl: string, query: string): Promise<{ history: Array<Record<string, unknown>> }> {
  return (await (await fetch(`${baseUrl}/gmail/v1/users/me/history?${query}`)).json()) as { history: Array<Record<string, unknown>> };
}

test('gmail drafts: a draft is kept unsent, in its thread, and listed', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const made = await post(baseUrl, '/gmail/v1/users/me/drafts', {
      message: { raw: raw(['To: rita@acme.example', 'Subject: Re: Q3', 'In-Reply-To: <q3@acme.example>', '', 'Looking now.']), threadId: 't-q3' },
    });
    assert.match(String(made.id), /^draft-/);
    assert.deepEqual(made.message, { id: (made.message as { id: string }).id, threadId: 't-q3', labelIds: ['DRAFT'] });
    const state = (await (await fetch(`${baseUrl}/fake-gmail/state`)).json()) as Record<string, Array<Record<string, unknown>>>;
    assert.deepEqual(state.outbox, []);
    assert.deepEqual(state.messages, []);
    assert.equal(state.drafts?.length, 1);
    assert.equal(state.drafts?.[0]?.draftId, made.id);
    assert.equal(state.drafts?.[0]?.subject, 'Re: Q3');
    assert.equal(state.drafts?.[0]?.inReplyTo, '<q3@acme.example>');
    const listed = (await (await fetch(`${baseUrl}/gmail/v1/users/me/drafts`)).json()) as { drafts: unknown[] };
    assert.equal(listed.drafts.length, 1);
  } finally {
    await close();
  }
});

test('gmail history: a label added later is a labelsAdded record, and the arrival stays where it was', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const arrived = await post(baseUrl, '/fake-gmail/messages', { id: 'm1', subject: 'Acme' });
    const start = Number(arrived.historyId) - 1;
    await post(baseUrl, '/gmail/v1/users/me/messages/m1/modify', { addLabelIds: ['Label_deals'] });
    // Adding a label it already carries records nothing.
    await post(baseUrl, '/gmail/v1/users/me/messages/m1/modify', { addLabelIds: ['Label_deals'] });

    const all = await history(baseUrl, `startHistoryId=${start}`);
    assert.deepEqual(
      all.history.map((r) => Object.keys(r).filter((k) => k !== 'id')),
      [['messagesAdded'], ['labelsAdded']],
    );
    const onlyArrivals = await history(baseUrl, `startHistoryId=${start}&historyTypes=messageAdded`);
    assert.equal(onlyArrivals.history.length, 1);
    const onlyLabels = await history(baseUrl, `startHistoryId=${start}&historyTypes=labelAdded&labelId=Label_deals`);
    assert.deepEqual(onlyLabels.history[0]?.labelsAdded, [
      { message: { id: 'm1', threadId: 'm1', labelIds: ['INBOX', 'UNREAD', 'Label_deals'] }, labelIds: ['Label_deals'] },
    ]);
    // After the label, the arrival is behind the mark: only the label remains.
    const after = await history(baseUrl, `startHistoryId=${arrived.historyId}`);
    assert.deepEqual(after.history.map((r) => Object.keys(r).filter((k) => k !== 'id')), [['labelsAdded']]);
  } finally {
    await close();
  }
});

test('gmail labels: a user label made by name gets an id, is listed beside the system ones, and a search takes its name', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    const made = await post(baseUrl, '/gmail/v1/users/me/labels', { name: 'Deals' });
    assert.match(String(made.id), /^Label_\d+$/);
    const listed = (await (await fetch(`${baseUrl}/gmail/v1/users/me/labels`)).json()) as { labels: Array<{ id: string; name: string }> };
    assert.ok(listed.labels.some((l) => l.id === 'INBOX'));
    assert.ok(listed.labels.some((l) => l.id === made.id && l.name === 'Deals'));
    await post(baseUrl, '/fake-gmail/messages', { id: 'm1', subject: 'Acme', labelIds: ['INBOX', made.id] });
    const found = (await (await fetch(`${baseUrl}/gmail/v1/users/me/messages?q=${encodeURIComponent('label:deals')}`)).json()) as { messages: Array<{ id: string }> };
    assert.deepEqual(found.messages.map((m) => m.id), ['m1']);
  } finally {
    await close();
  }
});

test('gmail attachments: a binary file seeded as base64 is served back byte for byte', async () => {
  const { baseUrl, close } = await bootApp();
  try {
    // Bytes that are not utf-8: a utf-8 round trip would replace them.
    const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff, 0xfe, 0x80, 0xc3, 0x0a]);
    const seeded = await fetch(`${baseUrl}/fake-gmail/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: 'Invoice',
        bodyText: 'Attached.',
        attachments: [{ filename: 'invoice.pdf', contentType: 'application/pdf', contentBase64: bytes.toString('base64') }],
      }),
    });
    const { id } = (await seeded.json()) as { id: string };
    const message = (await (await fetch(`${baseUrl}/gmail/v1/users/me/messages/${id}`)).json()) as {
      payload: { parts: { filename: string; body: { attachmentId?: string; size: number } }[] };
    };
    const part = message.payload.parts.find((p) => p.filename === 'invoice.pdf');
    assert.ok(part?.body.attachmentId);
    assert.equal(part.body.size, bytes.length);
    const served = (await (
      await fetch(`${baseUrl}/gmail/v1/users/me/messages/${id}/attachments/${part.body.attachmentId}`)
    ).json()) as { size: number; data: string };
    assert.equal(served.size, bytes.length);
    assert.ok(Buffer.from(served.data, 'base64url').equals(bytes));
  } finally {
    await close();
  }
});
