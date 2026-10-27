// An extraction over a file a module owns: a Gmail PDF attachment, read under
// `lf serve` through the module that owns it (`resolveFileRef`, as a write
// that files it elsewhere redeems it), then its text layer, then the model.
// The model is a fake that answers with what it was shown, so a field only
// the PDF holds reaches the run only if lf read the PDF.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { renderPlainTextPdf } from '../../../../modules/pdf/plain_text_pdf';
import { lf, served } from './example';
import { fakeChannels, gmailProject } from './gmail_fixture';

/** The Messages API, answering an extraction with the total the prompt shows it, else null. */
async function echoingAnthropic(): Promise<{ url: string; prompts: string[]; close(): Promise<void> }> {
  const prompts: string[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    request.on('end', () => {
      prompts.push(raw);
      const total = /TOTAL (EUR [\d,.]+)/.exec(raw)?.[1];
      const answer = JSON.stringify({ record: { total: total === undefined ? { value: null } : { value: total, evidence: `TOTAL ${total}` } } });
      const events: Array<[string, object]> = [
        ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'fake', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 8 } }],
        ['message_stop', { type: 'message_stop' }],
      ];
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, prompts, close: () => new Promise((done) => server.close(() => done())) };
}

const INVOICE = `import { gmail } from adapters
import { henry_mail } from credentials

mail = connect gmail using henry_mail

function invoice(msg: <mail-[:Message]->>) {
  msg-[a:Attachments]-> {
    d = extractOne([a.File], node I: "the invoice" { total: <text> "the amount the invoice asks for" })
    fail("\${a.Name} total \${d.total}")
  }
}

listen to mail { every: 1s } fire invoice
`;

test('lf serve: an extraction over a Gmail PDF attachment reads the PDF through Gmail, with no bytes-unavailable warning', async () => {
  const fake = await fakeChannels();
  const anthropic = await echoingAnthropic();
  try {
    const { dir } = await gmailProject(fake, 'gmail');
    appendFileSync(join(dir, '.lf/secrets.yaml'), `\nanthropic:\n  external: "@lf/anthropic"\n  api_key: test-key\n  base_url: ${anthropic.url}\n`);
    writeFileSync(join(dir, 'movements/hello.mvt'), INVOICE);
    const checked = lf(dir, 'check');
    assert.equal(checked.code, 0, checked.out);

    const pdf = Buffer.from(renderPlainTextPdf('INVOICE PW-20417 from Pinewood Supplies Ltd, net thirty days. Amount due: TOTAL EUR 4,812.50').bytes);
    const server = await served(dir);
    try {
      // The first poll sets the mark; mail after it fires.
      await new Promise((settled) => setTimeout(settled, 1500));
      await fake.message({ id: 'm-pw', subject: 'Invoice PW-20417', bodyText: 'Attached.', attachments: [{ filename: 'PW-20417.pdf', contentType: 'application/pdf', content: pdf.toString('latin1') }] });
      const line = await server.waitFor(/^run \S+ hello:invoice failed/);
      assert.match(line, /PW-20417\.pdf total EUR 4,812\.50/);
    } finally {
      await server.stop();
    }
    assert.ok(anthropic.prompts.some((p) => p.includes('Pinewood Supplies')), 'the model was shown the PDF text');
    const listed = lf(dir, 'runs').out.trim().split('\n')[0] ?? '';
    const shown = lf(dir, 'runs', 'show', listed.split(' ')[0] ?? '', '--json').out;
    assert.doesNotMatch(shown, /MOVENG_FILE_BYTES_UNAVAILABLE|bytes_unavailable/, shown);
  } finally {
    await fake.stop();
    await anthropic.close();
  }
});
