// The forms module as a host loads it: a write makes a form at a link under
// the module's door, the link answers with the form and takes one answer,
// and a recorded answer is an arrival on the form's Submissions.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModuleCredential } from 'module-kit';
import type { InboundCheckInput } from 'movement-engine/public/adapter';
import { adapterInProcess, fileKv, refusingFiles } from 'module-kit';
import { schemaTypeDescriptorSchema, unreadableAnswerShapeFrom } from 'engine-contracts/catalog';
import { userEditContext } from 'engine-contracts/mutation_context';

import { formsModule } from '../index';
import { FormsAdapter } from '../adapter';

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const DOOR = 'https://lf.example/api/public/webhook-sync/forms/forms';
const REFUND = { fields: { Approve: 'boolean', Note: { kind: 'maybeAbsent', of: 'text' } } };

/** A write of a form whose `Fields` holds `fields`, as the engine sends it. */
const formWrite = (fields: unknown, title = 't') => ({ recordType: 'Form', fields: { Title: title, Fields: fields }, mutationContext: userEditContext('test') });

function loaded(inboundUrl: string | null = DOOR) {
  const credential: ModuleCredential = { name: 'forms', fields: async () => ({}), update: async () => {} };
  return adapterInProcess(formsModule, {
    tenant: 'local',
    credential,
    fetch: globalThis.fetch,
    log: silent,
    files: refusingFiles('no files'),
    kv: fileKv(mkdtempSync(join(tmpdir(), 'lf-forms-')), 'local'),
    ...(inboundUrl !== null ? { inboundUrl } : {}),
    validateResults: true,
  });
}

function request(link: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}): InboundCheckInput {
  const url = new URL(link);
  return {
    request: {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: url.search.slice(1),
      headers: init.headers ?? {},
      body: Buffer.from(init.body ?? '').toString('base64'),
    },
  };
}

const json = { 'content-type': 'application/json', accept: 'application/json' };

async function newForm(adapter = loaded().adapter): Promise<{ adapter: typeof adapter; link: string; id: string }> {
  const written = await adapter.createRecord(formWrite(REFUND, 'Approve the refund?'));
  return { adapter, link: String(written.data['Url']), id: written.externalId };
}

describe('a form', () => {
  it('is made at an unguessable link under the door, keyed by its id', async () => {
    const { link, id } = await newForm();
    expect(link).toBe(`${DOOR}?form=${id}`);
    expect(id).toMatch(/^[A-Za-z0-9_-]{24}$/);
    const other = await newForm();
    expect(other.id).not.toBe(id);
  });

  it('cannot be made without a door, or asking for what a form cannot ask', async () => {
    const doorless = loaded(null).adapter;
    await expect(doorless.createRecord(formWrite(REFUND))).rejects.toThrow(
      "a form's link points at listen-fire serve, and none is known here: set publicUrl in lf.yaml to where listen-fire serve is reached",
    );
    const adapter = loaded().adapter;
    await expect(adapter.createRecord(formWrite({ fields: { Tags: { kind: 'list', of: 'text' } } }))).rejects.toThrow(
      "a form cannot ask for 'Tags'",
    );
    await expect(adapter.createRecord(formWrite('Refund'))).rejects.toThrow('this write sent no node');
  });

  it('declares Submissions typed by the node its Fields names', async () => {
    const adapter = loaded().adapter;
    const form = schemaTypeDescriptorSchema.parse(await adapter.describe('Form'));
    const submission = schemaTypeDescriptorSchema.parse(await adapter.describe('Submission'));
    const [submissions] = form.references;
    expect(submissions).toMatchObject({ name: 'Submissions', targetTypeId: 'Submission', readable: false, listenable: true, identity: 'Id', answerShapeFrom: 'Fields' });
    const descriptors = new Map([
      ['Form', form],
      ['Submission', submission],
    ]);
    expect(unreadableAnswerShapeFrom(submissions!, form, descriptors)).toBeUndefined();
  });

  it('needs a host that keeps the arrivals an inbound request reports (protocol 2.5)', () => {
    expect(formsModule.protocolMinor).toBe(5);
  });

  it('is waited on under its id', async () => {
    const forms = new FormsAdapter({ kv: fileKv(mkdtempSync(join(tmpdir(), 'lf-forms-')), 'local'), inboundUrl: DOOR, newId: () => 'f1' });
    expect(await forms.arrivals.awaitKeys({ edge: 'Submissions', heads: [{ recordId: 'f1' }, { recordId: 'f2' }] })).toEqual([{ key: 'f1' }, { key: 'f2' }]);
    await expect(forms.arrivals.awaitKeys({ edge: 'Answers', heads: [] })).rejects.toThrow("'Answers' is not a listenable edge");
  });
});

describe('its link', () => {
  it('describes the fields as JSON when asked for JSON', async () => {
    const { adapter, link } = await newForm();
    expect(await adapter.checkInbound!(request(link, { headers: { accept: 'application/json' } }))).toEqual({
      outcome: 'reply',
      status: 200,
      json: { title: 'Approve the refund?', fields: { Approve: { type: 'boolean', required: true }, Note: { type: 'text', required: false } } },
    });
  });

  it('is a form that posts back to it in a browser', async () => {
    const { adapter, link } = await newForm();
    const page = await adapter.checkInbound!(request(link, { headers: { accept: 'text/html' } }));
    expect(page).toMatchObject({ outcome: 'reply', status: 200 });
    const html = (page as { html: string }).html;
    expect(html).toContain('<form method="post" action="">');
    expect(html).toContain('<input type="radio" name="Approve" value="true" required>');
    expect(html).toContain('<textarea id="f-Note" name="Note" rows="3"></textarea>');
    expect(html).toContain('Approve the refund?');
  });

  it('refuses a value of the wrong kind, naming the field, and records nothing', async () => {
    const { adapter, link } = await newForm();
    const wrong = await adapter.checkInbound!(request(link, { method: 'POST', body: JSON.stringify({ Approve: 'yes' }), headers: json }));
    expect(wrong).toEqual({ outcome: 'reply', status: 400, json: { outcome: 'mismatch', message: "'Approve' must be true or false" } });
    const missing = await adapter.checkInbound!(request(link, { method: 'POST', body: '{}', headers: json }));
    expect(missing).toMatchObject({ status: 400, json: { message: "'Approve' is required" } });
    const stray = await adapter.checkInbound!(request(link, { method: 'POST', body: '{"Approve":true,"Amount":3}', headers: json }));
    expect(stray).toMatchObject({ status: 400, json: { message: "'Amount' is not a field of this form (it has: Approve, Note)" } });
    expect(await adapter.checkInbound!(request(link, { method: 'POST', body: '{"Approve":true}', headers: json }))).toMatchObject({ outcome: 'accepted' });
  });

  it('records one answer as an arrival on Submissions, and answers a different one 410', async () => {
    const { adapter, link, id } = await newForm();
    const recorded = await adapter.checkInbound!(request(link, { method: 'POST', body: JSON.stringify({ Approve: true, Note: 'ok' }), headers: json }));
    expect(recorded).toEqual({
      outcome: 'accepted',
      events: [],
      arrivals: [{ edge: 'Submissions', key: id, identity: id, landing: { recordId: id, recordType: 'Submission', fields: { Id: id, Approve: true, Note: 'ok' } } }],
      deliveryId: id,
      reply: { status: 200, json: { outcome: 'recorded' } },
    });
    const answered = { outcome: 'reply', status: 410, json: { outcome: 'answered' } };
    expect(await adapter.checkInbound!(request(link, { method: 'POST', body: JSON.stringify({ Approve: false }), headers: json }))).toEqual(answered);
    expect(await adapter.checkInbound!(request(link, { method: 'POST', body: JSON.stringify({ Approve: 'yes' }), headers: json }))).toEqual(answered);
    expect(await adapter.checkInbound!(request(link, { headers: { accept: 'application/json' } }))).toMatchObject({ status: 410 });
  });

  // The host refuses to keep an arrival its store cannot keep (503), and the
  // sender sends the post again: the form was answered by it, so the same
  // answer is reported again, under the same identity and delivery id. Had
  // the host kept the first, its log drops the second as a repeat.
  it('reports the same answer again when the same post is sent again', async () => {
    const { adapter, link } = await newForm();
    const post = () => adapter.checkInbound!(request(link, { method: 'POST', body: JSON.stringify({ Note: 'ok', Approve: true }), headers: json }));
    const first = await post();
    expect(first).toMatchObject({ outcome: 'accepted' });
    expect(await post()).toEqual(first);
    // The same values from a browser's form are the same answer.
    const fromBrowser = await adapter.checkInbound!(
      request(link, { method: 'POST', body: 'Approve=true&Note=ok', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } }),
    );
    expect(fromBrowser).toEqual(first);
  });

  it('records one of two different answers posted at once', async () => {
    const { adapter, link } = await newForm();
    const post = (approve: boolean) => adapter.checkInbound!(request(link, { method: 'POST', body: JSON.stringify({ Approve: approve }), headers: json }));
    const outcomes = await Promise.all([post(true), post(false)]);
    expect(outcomes.map((o) => (o.outcome === 'reply' ? o.status : o.outcome)).sort()).toEqual([410, 'accepted']);
  });

  it('takes a browser’s form, its values read from their text, and thanks it with a page', async () => {
    const { adapter, link, id } = await newForm();
    const posted = await adapter.checkInbound!(
      request(link, { method: 'POST', body: 'Approve=false&Note=', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' } }),
    );
    expect(posted).toMatchObject({ outcome: 'accepted', arrivals: [{ landing: { fields: { Id: id, Approve: false, Note: null } } }], reply: { status: 200 } });
    expect((posted as { reply: { html: string } }).reply.html).toContain('your answer is recorded');
  });

  it('answers 404 where there is no form', async () => {
    const adapter = loaded().adapter;
    for (const link of [`${DOOR}?form=nope`, DOOR]) {
      expect(await adapter.checkInbound!(request(link, { headers: { accept: 'application/json' } }))).toEqual({
        outcome: 'reply',
        status: 404,
        json: { outcome: 'not_found', message: 'there is no form at this link' },
      });
    }
  });
});
