// The builder under test and the user it talks to.
//
// The builder is a Messages-API tool loop whose ONLY tools are the automations
// MCP connector's, reached over HTTP exactly as an external client reaches them
// (a team API key as the bearer). Its system context is what such a client would
// carry: the connector's own instructions, and — when the variant says so — the
// builder skill. When it stops to talk, a second model plays the user: it answers
// from the task's hidden spec, in business terms, briefly, and says when the
// builder has finished.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

import { AUTOMATION_MCP_PATH } from '../../../interfaces/mcp/paths';
import type { Task } from './task';
import { addMessageUsage, costUsd, emptyUsage, type TokenUsage } from './usage';

type Variant = 'noskill' | 'skill';
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface ToolCallRecord {
  name: string;
  args: Record<string, unknown>;
  resultText: string;
  isError: boolean;
  ms: number;
  /** Which builder model call asked for it. */
  modelCall: number;
}

interface TranscriptEntry {
  role: 'builder' | 'user';
  text: string;
}

type BuildEndReason =
  | 'done'
  | 'model-call-budget'
  | 'user-turn-budget'
  | 'cost-budget'
  | 'refusal'
  | 'error';

interface BuildOutcome {
  endReason: BuildEndReason;
  error: string | null;
  toolCalls: ToolCallRecord[];
  transcript: TranscriptEntry[];
  modelCalls: number;
  userTurns: number;
  builderUsage: TokenUsage;
  userUsage: TokenUsage;
  wallMs: number;
}

interface BuildOptions {
  task: Task;
  variant: Variant;
  apiBaseUrl: string;
  apiKey: string;
  builderModel: string;
  builderEffort: Effort;
  userModel: string;
  maxModelCalls: number;
  maxUserTurns: number;
  /** The ceiling for the builder and the simulated user together; the judge's share is held back by the caller. */
  maxCostUsd: number;
  log: (line: string) => void;
}

const REPO_ROOT = path.resolve(__dirname, '../../../../../..');
const SKILL_PATH = path.join(REPO_ROOT, 'plugins/listen-fire-builder/skills/listen-fire-builder/SKILL.md');

/** The skill body as a client would load it: the frontmatter is routing metadata, not instructions. */
function readBuilderSkill(): string {
  return readFileSync(SKILL_PATH, 'utf-8').replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

function builderSystemPrompt(input: { serverInstructions: string; variant: Variant }): string {
  const parts = [
    `You are Claude, chatting with a user who has connected their Listen-Fire workspace. Use the Listen-Fire tools to do what they ask. Today is ${new Date().toISOString().slice(0, 10)}.`,
    `<mcp_server_instructions server="listen-fire-automation">\n${input.serverInstructions}\n</mcp_server_instructions>`,
  ];
  if (input.variant === 'skill') {
    parts.push(`<skill name="listen-fire-builder">\n${readBuilderSkill()}\n</skill>`);
  }
  return parts.join('\n\n');
}

// ── The simulated user ─────────────────────────────────────────────────────

const SimulatedUserReply = z.object({
  done: z
    .boolean()
    .describe('True when the assistant has said the automation is set up and live, so there is nothing left for you to say.'),
  reply: z.string().describe('What you say back. Empty when done is true.'),
});

function simulatedUserSystemPrompt(task: Task): string {
  return `You are role-playing a busy, non-technical person at a small venture firm who has asked an AI assistant to set up an automation in their Listen-Fire workspace. You are NOT an assistant. Stay in character.

What you asked for, word for word:
"""
${task.request}
"""

What you actually want — your private intent. Use it only to answer what you are asked:
"""
${task.hiddenSpec}
"""

How you talk:
- Answer only the question asked, in one to three short sentences, in plain business terms.
- Never volunteer details from your private intent that were not asked about. Never describe how to build it: you know nothing about programs, fields, listeners, syntax or tools.
- If asked to choose between options, pick the one your intent implies; if your intent is silent, say you don't mind and let them pick.
- If the assistant asks you to connect a system, say it is already connected.
- If the assistant asks whether it may go live, save, or switch it on, say yes.
- If the assistant asks you to test it by sending an email or event yourself, say you'd rather it just goes live and you'll watch what happens.
- Set done to true as soon as the assistant says the automation is set up, saved or live — even if it also offers extras. Do not ask follow-up questions just to keep talking.`;
}

function renderConversation(transcript: TranscriptEntry[]): string {
  return transcript
    .map((t) => `${t.role === 'builder' ? 'ASSISTANT' : 'YOU'}: ${t.text}`)
    .join('\n\n');
}

async function askSimulatedUser(input: {
  client: Anthropic;
  model: string;
  task: Task;
  transcript: TranscriptEntry[];
  usage: TokenUsage;
}): Promise<z.infer<typeof SimulatedUserReply>> {
  const response = await input.client.messages.parse({
    model: input.model,
    max_tokens: 2_000,
    system: simulatedUserSystemPrompt(input.task),
    output_config: { effort: 'low', format: zodOutputFormat(SimulatedUserReply) },
    messages: [
      {
        role: 'user',
        content: `The conversation so far:\n\n${renderConversation(input.transcript)}\n\nWhat do you say back to the assistant's last message?`,
      },
    ],
  });
  addMessageUsage(input.usage, response.usage);
  if (!response.parsed_output) {
    throw new Error(`the simulated user did not answer in the expected shape (stop_reason ${response.stop_reason})`);
  }
  return response.parsed_output;
}

// ── MCP ────────────────────────────────────────────────────────────────────

interface McpConnection {
  client: Client;
  tools: Anthropic.Tool[];
  instructions: string;
}

async function connectMcp(input: { apiBaseUrl: string; apiKey: string }): Promise<McpConnection> {
  const client = new Client({ name: 'automation-eval', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${input.apiBaseUrl}${AUTOMATION_MCP_PATH}`), {
    requestInit: { headers: { Authorization: `Bearer ${input.apiKey}` } },
  });
  await client.connect(transport);
  const listed = await client.listTools();
  const tools: Anthropic.Tool[] = listed.tools.map((t) => ({
    name: t.name,
    description: t.description ?? '',
    input_schema: { ...t.inputSchema, type: 'object' as const },
  }));
  return { client, tools, instructions: client.getInstructions() ?? '' };
}

function mcpResultText(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((item: { type?: string; text?: string }) => (item.type === 'text' ? (item.text ?? '') : JSON.stringify(item)))
    .join('\n');
}

async function callMcpTool(
  mcp: McpConnection,
  block: Anthropic.ToolUseBlock,
  modelCall: number,
): Promise<{ record: ToolCallRecord; result: Anthropic.ToolResultBlockParam }> {
  const args = (block.input ?? {}) as Record<string, unknown>;
  const started = Date.now();
  let text: string;
  let isError: boolean;
  try {
    const out = await mcp.client.callTool({ name: block.name, arguments: args });
    text = mcpResultText(out.content);
    isError = out.isError === true;
  } catch (err) {
    text = `Tool call failed: ${err instanceof Error ? err.message : String(err)}`;
    isError = true;
  }
  return {
    record: { name: block.name, args, resultText: text, isError, ms: Date.now() - started, modelCall },
    result: { type: 'tool_result', tool_use_id: block.id, content: text, ...(isError ? { is_error: true } : {}) },
  };
}

// ── The loop ───────────────────────────────────────────────────────────────

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

async function runBuilder(options: BuildOptions): Promise<BuildOutcome> {
  const started = Date.now();
  const client = new Anthropic();
  const builderUsage = emptyUsage();
  const userUsage = emptyUsage();
  const toolCalls: ToolCallRecord[] = [];
  const transcript: TranscriptEntry[] = [{ role: 'user', text: options.task.request }];
  let modelCalls = 0;
  let userTurns = 0;
  let lastCallCost = 0;

  const spent = () =>
    (costUsd(options.builderModel, builderUsage) ?? 0) + (costUsd(options.userModel, userUsage) ?? 0);
  const finish = (endReason: BuildEndReason, error: string | null = null): BuildOutcome => ({
    endReason,
    error,
    toolCalls,
    transcript,
    modelCalls,
    userTurns,
    builderUsage,
    userUsage,
    wallMs: Date.now() - started,
  });

  let mcp: McpConnection;
  try {
    mcp = await connectMcp({ apiBaseUrl: options.apiBaseUrl, apiKey: options.apiKey });
  } catch (err) {
    return finish('error', `could not connect to the automations MCP endpoint: ${err instanceof Error ? err.message : err}`);
  }

  const system = builderSystemPrompt({ serverInstructions: mcp.instructions, variant: options.variant });
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: options.task.request }];

  try {
    for (;;) {
      if (modelCalls >= options.maxModelCalls) return finish('model-call-budget');
      // Stop BEFORE a call that would likely cross the ceiling, not after: the
      // next call costs at least what the last one did (the context only grows).
      if (spent() + lastCallCost * 1.5 >= options.maxCostUsd) return finish('cost-budget');

      const response = await client.messages
        .stream({
          model: options.builderModel,
          max_tokens: 32_000,
          system,
          tools: mcp.tools,
          messages,
          cache_control: { type: 'ephemeral' },
          output_config: { effort: options.builderEffort },
        })
        .finalMessage();
      modelCalls += 1;
      const before = spent();
      addMessageUsage(builderUsage, response.usage);
      lastCallCost = spent() - before;
      // Append-only: thinking blocks go back exactly as they came.
      messages.push({ role: 'assistant', content: response.content });

      if (response.stop_reason === 'refusal') return finish('refusal', response.stop_details?.explanation ?? null);
      if (response.stop_reason === 'pause_turn') continue;

      const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      if (toolUses.length > 0 && response.stop_reason === 'tool_use') {
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of toolUses) {
          const { record, result } = await callMcpTool(mcp, block, modelCalls);
          toolCalls.push(record);
          results.push(result);
          options.log(`    tool ${record.name}${record.isError ? ' (error)' : ''} ${record.ms}ms`);
        }
        messages.push({ role: 'user', content: results });
        continue;
      }

      const said = textOf(response.content);
      transcript.push({ role: 'builder', text: said });
      options.log(`    builder: ${said.slice(0, 160).replace(/\n/g, ' ')}${said.length > 160 ? '…' : ''}`);
      if (userTurns >= options.maxUserTurns) return finish('user-turn-budget');

      const answer = await askSimulatedUser({
        client,
        model: options.userModel,
        task: options.task,
        transcript,
        usage: userUsage,
      });
      if (answer.done) return finish('done');
      userTurns += 1;
      transcript.push({ role: 'user', text: answer.reply });
      options.log(`    user: ${answer.reply.slice(0, 160)}`);
      messages.push({ role: 'user', content: answer.reply });
    }
  } catch (err) {
    return finish('error', err instanceof Error ? err.message : String(err));
  } finally {
    await mcp.client.close().catch(() => undefined);
  }
}

export { readBuilderSkill, runBuilder };
export type { BuildEndReason, BuildOutcome, Effort, ToolCallRecord, TranscriptEntry, Variant };
