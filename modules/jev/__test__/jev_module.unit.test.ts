// `@lf/jev` in process against the fake Jev: what it declares, the question
// each plugin asks, what it answers and what that cost, the input ceiling,
// and how it fails (a refused key at once, an overloaded Jev after retries).

import type { ModuleCredential } from 'module-kit';

import { pluginSpecsOf } from 'engine-contracts/plugin_spec';
import { pluginsInProcess, refusingFiles, refusingKv } from 'module-kit';

import { jevModule, jevModuleWith } from '../index';
import { JEV_PRICE_PER_MILLION_INPUT_TOKENS } from '../client';
import { startFakeJev, type FakeJev } from './fake_jev';

const quiet = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

function credential(fields: Record<string, string>): ModuleCredential {
  return { name: 'jev', fields: async () => fields, update: async () => undefined };
}

function loaded(fields: Record<string, string>) {
  return pluginsInProcess(jevModuleWith({ retryDelayMs: 1 }), {
    tenant: 't',
    credential: credential(fields),
    log: quiet,
    files: refusingFiles('none'),
    kv: refusingKv('none'),
    validateResults: true,
  });
}

describe('@lf/jev', () => {
  let fake: FakeJev;
  beforeEach(async () => {
    fake = await startFakeJev({ key: 'jev-key' });
  });
  afterEach(() => fake.close());

  const call = (name: string, config: Record<string, unknown>, fields: Record<string, string> = { apiKey: 'jev-key', baseUrl: fake.url }) =>
    loaded(fields).invoke({ name, config, extractedContext: {} });

  it('declares score and classify, both priced, taking a subject of any shape: score a number, classify a record', () => {
    expect(jevModule.name).toBe('@lf/jev');
    const specs = pluginSpecsOf(jevModule.plugins);
    expect(Object.keys(specs)).toEqual(['score', 'classify']);
    expect(specs.score).toMatchObject({
      args: ['subject', 'question'],
      requiredArgs: ['subject', 'question'],
      priced: true,
      argTypes: { subject: 'json', question: 'text' },
      output: { kind: 'value', type: 'number' },
    });
    expect(specs.classify).toMatchObject({
      args: ['subject', 'labels', 'question'],
      requiredArgs: ['subject', 'labels', 'question'],
      priced: true,
      argTypes: { subject: 'json', labels: { kind: 'list', of: 'text' }, question: 'text' },
      output: { kind: 'record', fields: { label: 'text', confidence: 'number' } },
    });
  });

  it('score asks one noul question over the text, and answers its probability, a number, and what it cost', async () => {
    const answer = await call('score', { subject: 'We are raising a seed round', question: 'Is this an inbound fundraising pitch about a round?' });
    expect(answer.data).toEqual({ value: 0.83 });
    const [request] = fake.requests;
    expect(request?.authorization).toBe('Bearer jev-key');
    expect(request?.body).toEqual({
      model: 'jev-latest',
      state: 'We are raising a seed round',
      questions: { answer: { type: 'noul', instructions: 'Is this an inbound fundraising pitch about a round?' } },
    });
    const tokens = Math.ceil(JSON.stringify(request?.body).length / 4);
    expect(answer.costMicrodollars).toBe(Math.ceil(tokens * JEV_PRICE_PER_MILLION_INPUT_TOKENS));
    expect(answer.costMicrodollars).toBeGreaterThan(0);
  });

  it('score reads a record as its fields, leaving out the empty ones', async () => {
    const answer = await call('score', { subject: { Subject: 'Seed round', Body: 'We are raising', Cc: '', Notes: null }, question: 'Mentions a round?' });
    expect(answer.data).toEqual({ value: 0.83 });
    expect(fake.requests[0]?.body.state).toEqual({ Subject: 'Seed round', Body: 'We are raising' });
  });

  it('classify asks one choice question, its labels as the options, and answers the label and its confidence', async () => {
    const answer = await call('classify', {
      subject: 'Hi, quick intro to Ada at Vireo',
      labels: ['pitch', 'intro', 'spam'],
      question: 'What kind of inbound email is this?',
    });
    expect(answer.data).toEqual({ label: 'intro', confidence: 0.91 });
    expect(fake.requests[0]?.body.questions).toEqual({
      answer: { type: 'choice', instructions: 'What kind of inbound email is this?', criteria: { o0: 'pitch', o1: 'intro', o2: 'spam' } },
    });
    expect(answer.costMicrodollars).toBeGreaterThan(0);
  });

  it('refuses labels it cannot ask about, and an empty subject or question, before calling Jev', async () => {
    await expect(call('classify', { subject: 'x', labels: ['only'], question: 'q' })).rejects.toThrow('jev.classify needs at least two labels');
    await expect(call('classify', { subject: 'x', labels: ['a', 'a'], question: 'q' })).rejects.toThrow('"a" is given twice');
    await expect(call('classify', { subject: 'x', labels: ['a', ''], question: 'q' })).rejects.toThrow('a label is empty');
    await expect(call('score', { subject: '', question: 'q' })).rejects.toThrow('jev.score has nothing to read: the subject is empty');
    await expect(call('score', { subject: 'x', question: ' ' })).rejects.toThrow('jev.score needs a question');
    expect(fake.requests).toEqual([]);
  });

  it('refuses a subject over the input ceiling, saying how large it was, before calling Jev', async () => {
    await expect(call('score', { subject: 'word '.repeat(30_000), question: 'Long?' })).rejects.toThrow(
      /jev\.score: the subject and question come to about \d+ tokens, over the 30000 Jev reads/,
    );
    expect(fake.requests).toEqual([]);
  });

  it('retries a rate-limited or overloaded Jev, and fails naming the status after three tries', async () => {
    fake.failNext(429, 529);
    expect((await call('score', { subject: 'a round', question: 'round?' })).data).toEqual({ value: 0.83 });
    expect(fake.requests).toHaveLength(3);
    fake.failNext(529, 529, 529);
    await expect(call('score', { subject: 'a round', question: 'round?' })).rejects.toThrow('Jev is overloaded or rate-limiting (529) after 3 tries');
    expect(fake.requests).toHaveLength(6);
  });

  it('fails at once, naming the credential, when Jev refuses the key or there is none', async () => {
    await expect(call('score', { subject: 'a', question: 'b' }, { apiKey: 'wrong', baseUrl: fake.url })).rejects.toThrow(
      'Jev refused the API key (401): check the apiKey of the @lf/jev credential',
    );
    expect(fake.requests).toHaveLength(1);
    await expect(call('score', { subject: 'a', question: 'b' }, { baseUrl: fake.url })).rejects.toThrow(
      '@lf/jev has no API key: add a credential with `listen-fire credential add --module @lf/jev <name>`',
    );
    expect(fake.requests).toHaveLength(1);
  });
});
