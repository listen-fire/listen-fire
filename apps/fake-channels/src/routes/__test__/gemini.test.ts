import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { FAKE_THOUGHT_SIGNATURE, geminiRoutes } from '../gemini';

/**
 * Route-level tests for the fake Gemini, run via `node --test` (through
 * `tsx --test`, no jest in this package — see package.json).
 *
 * The fake's worth is that it refuses what real Gemini refuses: a body off the
 * documented schema, and a follow-up turn that drops the thought signature it
 * was given. A fake that answered anything would pass while the translator
 * sent requests Google rejects.
 */

async function bootApp(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/gemini', geminiRoutes());
  const server = await new Promise<import('http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://localhost:${port}/gemini`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const PROJECT = '/v1/projects/fake-project/locations/europe-west4/publishers/google/models';
const MODEL = `${PROJECT}/gemini-3-pro`;

async function call(
  baseUrl: string,
  options: { method: 'generateContent' | 'streamGenerateContent'; body: unknown; scenario?: string; model?: string },
): Promise<{ status: number; text: string }> {
  const suffix = options.method === 'streamGenerateContent' ? ':streamGenerateContent?alt=sse' : ':generateContent';
  const res = await fetch(`${baseUrl}${options.model ? `${PROJECT}/${options.model}` : MODEL}${suffix}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(options.scenario ? { 'x-fake-scenario': options.scenario } : {}) },
    body: JSON.stringify(options.body),
  });
  return { status: res.status, text: await res.text() };
}

/** The JSON objects of an SSE body, in order. */
function events(text: string): Array<Record<string, any>> {
  return text
    .split('\n\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice('data: '.length)));
}

const TOOLS = [{ functionDeclarations: [{ name: 'search', parametersJsonSchema: { type: 'object' } }] }];
const HI = { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

test('text: streams fragments on the SDK’s path, usage on the last', async () => {
  const app = await bootApp();
  try {
    const { status, text } = await call(app.baseUrl, { method: 'streamGenerateContent', body: HI });
    assert.equal(status, 200);
    const chunks = events(text);
    assert.equal(chunks.length, 2);
    assert.equal(chunks.map((c) => c.candidates[0].content.parts[0].text).join(''), 'Hello from the fake Gemini.');
    assert.equal(chunks[1].candidates[0].finishReason, 'STOP');
    assert.equal(chunks[1].usageMetadata.promptTokenCount, 12);
  } finally {
    await app.close();
  }
});

test('generateContent answers in one body', async () => {
  const app = await bootApp();
  try {
    const { status, text } = await call(app.baseUrl, { method: 'generateContent', body: HI, scenario: 'max_tokens' });
    assert.equal(status, 200);
    const body = JSON.parse(text);
    assert.equal(body.candidates[0].finishReason, 'MAX_TOKENS');
  } finally {
    await app.close();
  }
});

test('function_call and text_and_function_call call the first declared function', async () => {
  const app = await bootApp();
  try {
    const one = events((await call(app.baseUrl, { method: 'streamGenerateContent', body: { ...HI, tools: TOOLS }, scenario: 'function_call' })).text);
    assert.deepEqual(one[0].candidates[0].content.parts, [{ functionCall: { name: 'search', args: {} } }]);

    const both = events((await call(app.baseUrl, { method: 'streamGenerateContent', body: { ...HI, tools: TOOLS }, scenario: 'text_and_function_call' })).text);
    assert.deepEqual(both[0].candidates[0].content.parts, [
      { text: 'Let me check.' },
      { functionCall: { name: 'search', args: {} } },
    ]);
  } finally {
    await app.close();
  }
});

test('a body off the documented schema is refused as Google refuses it', async () => {
  const app = await bootApp();
  try {
    const stray = await call(app.baseUrl, { method: 'streamGenerateContent', body: { ...HI, cache_control: { type: 'ephemeral' } } });
    assert.equal(stray.status, 400);
    assert.equal(JSON.parse(stray.text).error.status, 'INVALID_ARGUMENT');

    const both = await call(app.baseUrl, {
      method: 'streamGenerateContent',
      body: { ...HI, generationConfig: { thinkingConfig: { thinkingBudget: 10, thinkingLevel: 'HIGH' } } },
    });
    assert.equal(both.status, 400);

    const unknown = await call(app.baseUrl, { method: 'streamGenerateContent', body: HI, scenario: 'nope' });
    assert.equal(unknown.status, 400);
  } finally {
    await app.close();
  }
});

test('thought_signature: issues a signature and refuses a follow-up that drops it', async () => {
  const app = await bootApp();
  try {
    const first = events((await call(app.baseUrl, { method: 'streamGenerateContent', body: { ...HI, tools: TOOLS }, scenario: 'thought_signature' })).text);
    assert.deepEqual(first[0].candidates[0].content.parts, [{ text: 'Deciding which tool to call.', thought: true }]);
    assert.deepEqual(first[1].candidates[0].content.parts, [
      { functionCall: { name: 'search', args: {} }, thoughtSignature: FAKE_THOUGHT_SIGNATURE },
    ]);

    const followUp = (signature?: string) => ({
      tools: TOOLS,
      contents: [
        HI.contents[0],
        { role: 'model', parts: [{ functionCall: { name: 'search', args: {} }, ...(signature ? { thoughtSignature: signature } : {}) }] },
        { role: 'user', parts: [{ functionResponse: { name: 'search', response: { output: 'found' } } }] },
      ],
    });

    const dropped = await call(app.baseUrl, { method: 'streamGenerateContent', body: followUp(), scenario: 'thought_signature' });
    assert.equal(dropped.status, 400);
    assert.match(JSON.parse(dropped.text).error.message, /missing a thought_signature/);

    const echoed = await call(app.baseUrl, { method: 'streamGenerateContent', body: followUp(FAKE_THOUGHT_SIGNATURE), scenario: 'thought_signature' });
    assert.equal(echoed.status, 200);
    assert.equal(events(echoed.text).map((c) => c.candidates[0].content.parts[0].text).join(''), 'Done: the tool answered.');
  } finally {
    await app.close();
  }
});

test('a wire model named fake-<scenario> picks the scenario when no header does', async () => {
  const app = await bootApp();
  try {
    const { status, text } = await call(app.baseUrl, { method: 'generateContent', body: HI, model: 'fake-max_tokens' });
    assert.equal(status, 200);
    assert.equal(JSON.parse(text).candidates[0].finishReason, 'MAX_TOKENS');
  } finally {
    await app.close();
  }
});

test('with no scenario named, the fake answers as a model would', async () => {
  const app = await bootApp();
  try {
    const partsOf = async (body: unknown) =>
      events((await call(app.baseUrl, { method: 'streamGenerateContent', body })).text).flatMap((c) => c.candidates[0].content.parts);

    // No functions offered: text.
    assert.equal((await partsOf(HI)).map((p) => p.text).join(''), 'Hello from the fake Gemini.');

    // Functions offered and the user spoke last: a call, arguments built from the schema.
    const answer = {
      name: 'answer',
      parametersJsonSchema: {
        type: 'object',
        properties: { verdict: { enum: ['yes', 'no'] }, score: { type: 'integer' }, note: { type: 'string' } },
        required: ['verdict', 'score'],
      },
    };
    const offered = await partsOf({ ...HI, tools: [{ functionDeclarations: [TOOLS[0].functionDeclarations[0], answer] }] });
    assert.deepEqual(offered, [{ functionCall: { name: 'search', args: {} } }]);

    // Forced to one name (a structured call): that function, schema-valid arguments.
    const forced = await partsOf({
      ...HI,
      tools: [{ functionDeclarations: [TOOLS[0].functionDeclarations[0], answer] }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['answer'] } },
    });
    assert.deepEqual(forced, [{ functionCall: { name: 'answer', args: { verdict: 'yes', score: 1 } } }]);

    // Mode NONE: text even with functions offered.
    const none = await partsOf({ ...HI, tools: TOOLS, toolConfig: { functionCallingConfig: { mode: 'NONE' } } });
    assert.ok(none.every((p) => typeof p.text === 'string'));

    // The last turn is a function response: text, so a tool loop ends.
    const after = await partsOf({
      tools: TOOLS,
      contents: [
        HI.contents[0],
        { role: 'model', parts: [{ functionCall: { name: 'search', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'search', response: { output: 'found' } } }] },
      ],
    });
    assert.equal(after.map((p) => p.text).join(''), 'Done: the tool answered.');

    // The header still wins over inference.
    const header = events(
      (await call(app.baseUrl, { method: 'streamGenerateContent', body: { ...HI, tools: TOOLS }, scenario: 'max_tokens' })).text,
    );
    assert.equal(header[header.length - 1].candidates[0].finishReason, 'MAX_TOKENS');
  } finally {
    await app.close();
  }
});
