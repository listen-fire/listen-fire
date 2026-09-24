import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

// A stand-in for Gemini on Vertex, enough to prove the API's Gemini translator
// end to end: the real `@google/genai` client, pointed here by
// `GEMINI_BASE_URL=<this host>/gemini`, sends its real wire request, and this
// route refuses any body the documented `generateContent` schema would refuse.
//
// Paths are the ones the SDK builds under a base URL with a project and
// location set: `/v1/projects/:p/locations/:l/publishers/google/models/:m`
// followed by `:generateContent` or `:streamGenerateContent` (`?alt=sse`).
//
// The reply is canned, chosen by the `X-Fake-Scenario` header, else by a
// wire model named `fake-<scenario>`, else `text`. The model name is there
// because the API's provider sends no per-call headers: a verify run picks a
// scenario per registry name through the map, e.g.
// `{"claude-opus-5": "gemini/fake-function_call"}`. Once the conversation's last turn is a function response, every
// scenario answers with plain text, so a tool loop driven through here ends.
//
// `thought_signature` is the one scenario that checks the CONVERSATION as
// well as the shape: a follow-up turn must carry back, on the first function
// call of each model turn, the signature this fake issued — which is the rule
// real Gemini enforces with a 400.

const SCENARIOS = ['text', 'function_call', 'text_and_function_call', 'max_tokens', 'thought_signature'] as const;
type Scenario = (typeof SCENARIOS)[number];

export const FAKE_THOUGHT_SIGNATURE = 'ZmFrZS10aG91Z2h0LXNpZ25hdHVyZQ==';

// The documented request schema, strict where the translator writes: a field
// it should not have sent is a failure here, not a silently ignored extra.
const Part = z
  .object({
    text: z.string().optional(),
    inlineData: z.object({ mimeType: z.string().min(1), data: z.string().min(1) }).strict().optional(),
    functionCall: z
      .object({ name: z.string().min(1), args: z.record(z.string(), z.unknown()).optional(), id: z.string().optional() })
      .strict()
      .optional(),
    functionResponse: z
      .object({ name: z.string().min(1), response: z.record(z.string(), z.unknown()), id: z.string().optional() })
      .strict()
      .optional(),
    thought: z.boolean().optional(),
    thoughtSignature: z.string().optional(),
  })
  .strict()
  .refine(
    (p) => [p.text, p.inlineData, p.functionCall, p.functionResponse].filter((v) => v !== undefined).length === 1,
    { message: 'a part carries exactly one of text, inlineData, functionCall, functionResponse' },
  );

const Content = z.object({ role: z.enum(['user', 'model']).optional(), parts: z.array(Part).min(1) }).strict();

const GenerateContentRequest = z
  .object({
    contents: z.array(Content).min(1),
    systemInstruction: z.object({ role: z.string().optional(), parts: z.array(Part).min(1) }).strict().optional(),
    tools: z
      .array(
        z
          .object({
            functionDeclarations: z.array(
              z
                .object({
                  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/),
                  description: z.string().optional(),
                  parametersJsonSchema: z.unknown().optional(),
                  parameters: z.unknown().optional(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .optional(),
    toolConfig: z
      .object({
        functionCallingConfig: z
          .object({
            mode: z.enum(['AUTO', 'ANY', 'NONE', 'VALIDATED']),
            allowedFunctionNames: z.array(z.string()).optional(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    generationConfig: z
      .object({
        maxOutputTokens: z.number().int().positive().optional(),
        temperature: z.number().min(0).max(2).optional(),
        stopSequences: z.array(z.string()).max(5).optional(),
        thinkingConfig: z
          .object({
            thinkingBudget: z.number().int().optional(),
            thinkingLevel: z.enum(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']).optional(),
            includeThoughts: z.boolean().optional(),
          })
          .strict()
          .refine((c) => c.thinkingBudget === undefined || c.thinkingLevel === undefined, {
            message: 'thinkingBudget and thinkingLevel cannot both be set',
          })
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type GenerateContentRequest = z.infer<typeof GenerateContentRequest>;
type WirePart = z.infer<typeof Part>;

interface Reply {
  chunks: WirePart[][];
  finishReason: 'STOP' | 'MAX_TOKENS';
}

const USAGE = {
  promptTokenCount: 12,
  candidatesTokenCount: 8,
  thoughtsTokenCount: 4,
  cachedContentTokenCount: 2,
  totalTokenCount: 24,
};

function googleError(res: Response, status: number, message: string): void {
  const statusName = status === 400 ? 'INVALID_ARGUMENT' : status === 404 ? 'NOT_FOUND' : 'INTERNAL';
  res.status(status).json({ error: { code: status, message, status: statusName } });
}

function scenarioOf(req: Request, model: string): Scenario | undefined {
  const raw = req.get('x-fake-scenario') ?? (model.startsWith('fake-') ? model.slice('fake-'.length) : 'text');
  return SCENARIOS.find((s) => s === raw);
}

function firstFunctionName(body: GenerateContentRequest): string {
  return body.tools?.[0]?.functionDeclarations[0]?.name ?? 'lookup';
}

/** Why a follow-up turn would be refused by real Gemini for a missing
 *  signature, or undefined when every model turn that called a function sent
 *  this fake's signature back on its first call. */
function missingSignature(body: GenerateContentRequest): string | undefined {
  for (const [index, content] of body.contents.entries()) {
    if (content.role !== 'model') continue;
    const firstCall = content.parts.find((p) => p.functionCall);
    if (firstCall && firstCall.thoughtSignature !== FAKE_THOUGHT_SIGNATURE) {
      return `Function call is missing a thought_signature in functionCall parts (contents[${index}]).`;
    }
  }
  return undefined;
}

function replyFor(scenario: Scenario, body: GenerateContentRequest): Reply {
  const last = body.contents[body.contents.length - 1];
  if (last.parts.some((p) => p.functionResponse)) {
    return { chunks: [[{ text: 'Done: ' }], [{ text: 'the tool answered.' }]], finishReason: 'STOP' };
  }
  const name = firstFunctionName(body);
  switch (scenario) {
    case 'text':
      return { chunks: [[{ text: 'Hello from ' }], [{ text: 'the fake Gemini.' }]], finishReason: 'STOP' };
    case 'function_call':
      return { chunks: [[{ functionCall: { name, args: {} } }]], finishReason: 'STOP' };
    case 'text_and_function_call':
      return { chunks: [[{ text: 'Let me check.' }, { functionCall: { name, args: {} } }]], finishReason: 'STOP' };
    case 'max_tokens':
      return { chunks: [[{ text: 'This answer is cut o' }]], finishReason: 'MAX_TOKENS' };
    case 'thought_signature':
      return {
        chunks: [
          [{ text: 'Deciding which tool to call.', thought: true }],
          [{ functionCall: { name, args: {} }, thoughtSignature: FAKE_THOUGHT_SIGNATURE }],
        ],
        finishReason: 'STOP',
      };
  }
}

function responseChunk(parts: WirePart[], final: { finishReason: Reply['finishReason'] } | undefined, model: string) {
  return {
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(final ? { finishReason: final.finishReason } : {}) }],
    modelVersion: model,
    responseId: 'fake-gemini-response',
    ...(final ? { usageMetadata: USAGE } : {}),
  };
}

const MODEL_PATH =
  /^\/(v1|v1beta1)\/projects\/([^/]+)\/locations\/([^/]+)\/publishers\/google\/models\/([^/:]+):(generateContent|streamGenerateContent)$/;

export function geminiRoutes(): Router {
  const r = Router();

  r.post(MODEL_PATH, (req, res) => {
    const match = MODEL_PATH.exec(req.path);
    if (!match) return googleError(res, 404, 'unknown path');
    const model = match[4];
    const method = match[5];

    const parsed = GenerateContentRequest.safeParse(req.body);
    if (!parsed.success) {
      return googleError(res, 400, `Invalid generateContent request: ${parsed.error.message}`);
    }
    const scenario = scenarioOf(req, model);
    if (!scenario) {
      return googleError(res, 400, `Unknown fake scenario; expected one of ${SCENARIOS.join(', ')}.`);
    }
    if (scenario === 'thought_signature') {
      const missing = missingSignature(parsed.data);
      if (missing) return googleError(res, 400, missing);
    }

    const reply = replyFor(scenario, parsed.data);
    const bodies = reply.chunks.map((parts, i) =>
      responseChunk(parts, i === reply.chunks.length - 1 ? { finishReason: reply.finishReason } : undefined, model),
    );

    if (method === 'generateContent') {
      return res.json(responseChunk(reply.chunks.flat(), { finishReason: reply.finishReason }, model));
    }
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    for (const body of bodies) res.write(`data: ${JSON.stringify(body)}\n\n`);
    res.end();
  });

  return r;
}
