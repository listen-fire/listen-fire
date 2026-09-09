import { randomUUID } from 'node:crypto';

import Anthropic from '@anthropic-ai/sdk';
import { backOff } from 'exponential-backoff';
import { z } from 'zod';

import { buildStructuredTool, extractStructuredResult } from './structured';

import { getEnvVar } from '../utils/environment';
import { Queue } from '../utils/queue';
import { logger } from '../../services/logger';
import { SECOND } from '../../constants';
import { recordLlmUsage, runFields } from '../llm_usage';

// Read at first USE, not at module load. `getEnvVar` throws in production when
// the key is unset, so an eager read made merely IMPORTING this module enough
// to stop the process booting — including for a deployment that runs entirely
// on per-team keys (BYOT) or uses no LLM at all. Memoized: still one read and
// one client, just on first call rather than on import.
let platformClient: Anthropic | undefined;
function platformAnthropic(): Anthropic {
  return (platformClient ??= new Anthropic({
    apiKey: getEnvVar('ANTHROPIC_API_KEY', {
      devDefault: 'test',
      because: 'it is the platform key for any Anthropic call that does not carry a team key',
    }),
  }));
}

/**
 * The Anthropic client for a call: the team's own key (BYOT — pricing-v2 §B.2)
 * when supplied, else the platform singleton. A per-call client is cheap and
 * keeps the request server-side (no endpoint override — prompts never leave our
 * backend). The key is NEVER part of any recording hash.
 */
function clientFor(byotApiKey?: string): Anthropic {
  return byotApiKey ? new Anthropic({ apiKey: byotApiKey }) : platformAnthropic();
}

const rateLimitQueue = new Queue<any>({ concurrency: 8 });

const RETRY_LIMIT = 4;
const INITIAL_DELAY = 1 * SECOND;
const TIME_MULTIPLE = 4;
const RATE_LIMIT_DELAY = 30 * SECOND;

async function enqueueQuery<T>(fn: () => Promise<T>, signal?: AbortSignal) {
  return rateLimitQueue.enqueue(async () => {
    return backOff(fn, {
      jitter: 'none',
      numOfAttempts: RETRY_LIMIT,
      startingDelay: INITIAL_DELAY,
      timeMultiple: TIME_MULTIPLE,
      retry: async (e, attempt) => {
        if (signal?.aborted) return false;
        if (e instanceof Error && e.message.includes('429')) {
          logger.info(`Hit Anthropic rate limit, waiting ${RATE_LIMIT_DELAY / SECOND}s`);
          await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DELAY));
        } else if (e instanceof Error && e.message.includes('401')) {
          return false;
        }
        if (attempt < RETRY_LIMIT) {
          logger.info(
            `Retrying Anthropic query in ${(INITIAL_DELAY / SECOND) * TIME_MULTIPLE ** (attempt - 1)}s`,
            { error: e },
          );
        }
        return true;
      },
    });
  });
}

interface OpenAIToolDef {
  type: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Anthropic models speak two different thinking-config dialects:
 *  - The adaptive families (Opus 4.6+, Sonnet 5, Fable / Mythos) REQUIRE
 *    `thinking: { type: 'adaptive' }` paired with `output_config: { effort }`
 *    and REJECT `{ type: 'enabled' }`.
 *  - The explicit-budget families (Haiku, legacy Sonnet 4.x) REQUIRE
 *    `thinking: { type: 'enabled', budget_tokens }`, REJECT `adaptive`, and
 *    do NOT accept `output_config`.
 *
 * Callers express intent ("think hard") via whatever shape suited the model
 * they were originally written against. This normalizes that intent to the
 * dialect the actual `model` accepts, so swapping a caller's model id is all
 * it takes to switch families — the wrapper fixes up the thinking config.
 *
 * `budget_tokens` is clamped below `max_output_tokens` (Anthropic requires
 * max_output_tokens > thinking.budget_tokens).
 *
 */
function resolveThinkingConfig(options: {
  model: string;
  thinking: AnthropicToolLoopParams['thinking'];
  outputConfig: AnthropicToolLoopParams['output_config'];
  maxOutputTokens: number;
}): {
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' };
  output_config?: { effort: 'low' | 'medium' | 'high' };
} {
  const { model, thinking, outputConfig, maxOutputTokens } = options;
  if (!thinking) return {};

  // Adaptive-thinking families (Opus 4.6+, Sonnet 5, Fable / Mythos). Sonnet 5
  // in particular REJECTS the `enabled` / `budget_tokens` dialect that Sonnet
  // 4.x required, so it must route here.
  const usesAdaptiveThinking =
    model.startsWith('claude-opus') ||
    model.startsWith('claude-sonnet-5') ||
    model.startsWith('claude-fable') ||
    model.startsWith('claude-mythos');

  if (usesAdaptiveThinking) {
    return {
      thinking: { type: 'adaptive' },
      output_config: outputConfig ?? { effort: 'high' },
    };
  }

  // Haiku / legacy Sonnet 4.x: explicit budget, no output_config.
  const requestedBudget = thinking.type === 'enabled' ? thinking.budget_tokens : 8000;
  const budget_tokens = Math.min(requestedBudget, Math.max(1024, maxOutputTokens - 1024));
  return { thinking: { type: 'enabled', budget_tokens } };
}

function convertToolDefinitions(openaiTools: OpenAIToolDef[]): Anthropic.Tool[] {
  return openaiTools.map((tool, i) => {
    const converted: Anthropic.Tool = {
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters as Anthropic.Tool.InputSchema,
    };
    // Mark the last tool with cache_control so system + tools prefix gets cached
    if (i === openaiTools.length - 1) {
      converted.cache_control = { type: 'ephemeral' };
    }
    return converted;
  });
}

/**
 * Per-request view of `messages` with a cache breakpoint on the final
 * content block. Applied to a shallow copy, never the stored array:
 * the breakpoint must sit at the *current* end of the conversation on
 * every request, and the API allows at most 4 breakpoints per request
 * (tools carry one, system up to two, so exactly one lives here).
 *
 * Caching is a strict prefix match and only content **before** a
 * breakpoint is ever read from cache — without this marker the entire
 * conversation history is reprocessed at full price on every turn.
 * With it, each request's history is readable by the next request
 * (the API walks back up to 20 content blocks to find the previous
 * entry, so turns with very large parallel tool fan-outs may still
 * miss — acceptable, that's the rare case).
 */
function withFinalCacheBreakpoint(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  if (messages.length === 0) return messages;
  const last = messages[messages.length - 1];

  let content: Anthropic.MessageParam['content'];
  if (typeof last.content === 'string') {
    content = [
      {
        type: 'text' as const,
        text: last.content,
        cache_control: { type: 'ephemeral' as const },
      },
    ];
  } else {
    const blocks = [...last.content];
    const lastBlock = blocks[blocks.length - 1];
    // thinking blocks can't carry cache_control. In practice the final
    // message is always a user turn (text or tool_result), but guard
    // rather than 400 the whole request on an unexpected shape.
    if (
      lastBlock.type === 'text' ||
      lastBlock.type === 'tool_use' ||
      lastBlock.type === 'tool_result'
    ) {
      blocks[blocks.length - 1] = {
        ...lastBlock,
        cache_control: { type: 'ephemeral' as const },
      };
    }
    content = blocks as Anthropic.MessageParam['content'];
  }

  return [...messages.slice(0, -1), { role: last.role, content }];
}

interface TurnEvent {
  turn: number;
  /**
   * Concatenated text-block content emitted alongside any tool calls on
   * this turn. Despite the name (kept for backwards compatibility with
   * the runner's `emitUpdate({ type: 'thinking', ... })` UI hook),
   * this is the model's visible-to-user text, not extended thinking.
   */
  thinkingText: string | null;
  /**
   * Extended-thinking content emitted by the model when the request had
   * `thinking: { type: 'enabled' }`. Null when thinking wasn't enabled
   * or the model produced no thinking block this turn.
   *
   * Captured per turn so the M2 instrumentation in the agent runner can
   * concatenate across turns and persist into `agent_message.metadata
   * .thoughts.thinking`.
   */
  extendedThinking: string | null;
  toolNames: string[];
  llmMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /**
   * Set when the API stopped the turn at `max_tokens`, so a harness can see the
   * truncation instead of inferring it from a turn that did nothing.
   *  - 'text' — visible text came back; the loop asks the model to continue it.
   *  - 'no_output' — nothing usable came back: a tool call cut off mid-JSON
   *    (the common case) or thinking that consumed the whole budget. No tool
   *    ran. The loop asks for a smaller step; two of these in a row is fatal.
   */
  truncated?: 'text' | 'no_output';
}

/**
 * M4: callers that want explicit control over cache breakpoints
 * (e.g. Setup's `[static prompt][running state]` two-block layout so
 * the static prefix stays cacheable while the running state changes
 * every Kth turn) pass `system` as an array. Single-string callers
 * continue to get a single cached system block, preserving existing
 * behaviour everywhere else.
 *
 */
export interface AnthropicSystemBlock {
  text: string;
  /**
   * When set, the API treats this block as a cache breakpoint with
   * 5-minute ephemeral TTL. The default (omitted) means no breakpoint
   * on this block — caching cascades from earlier marked blocks.
   */
  cacheControl?: 'ephemeral';
}

interface AnthropicToolLoopParams {
  model?: string;
  max_output_tokens?: number;
  maxTurns?: number;
  /**
   * Either a plain string (legacy / simple callers — gets a single
   * `cache_control: ephemeral` system block) OR an array of explicit
   * system blocks where each entry controls its own cache breakpoint.
   * The array form is used by Setup's M4 layout (static prompt as one
   * stable cached block + running state as a separate block whose
   * `cache_control` is the agreed prefix boundary).
   */
  system: string | AnthropicSystemBlock[];
  userMessage: string;
  conversationHistory?: Array<{ role: 'user' | 'assistant'; content: string }>;
  tools: OpenAIToolDef[];
  onTurn?: (event: TurnEvent) => void;
  label?: string;
  signal?: AbortSignal;
  /**
   * Opt into Anthropic extended thinking. Two shapes:
   *  - `{ type: 'enabled', budget_tokens }` — Sonnet / older Claude 4
   *    series; explicit thinking budget.
   *  - `{ type: 'adaptive' }` — Opus 4.7+; the model decides how much
   *    to think based on `output_config.effort`. Pair with that field.
   *
   * The loop forwards `thinking` (and `output_config`, when set) verbatim
   * to the Messages API and surfaces the resulting `thinking` blocks via
   * `TurnEvent.extendedThinking` regardless of the variant.
   *
   */
  thinking?: { type: 'enabled'; budget_tokens: number } | { type: 'adaptive' };
  /**
   * Effort knob for Opus 4.7's adaptive thinking. Required when
   * `thinking.type === 'adaptive'`. Ignored otherwise.
   */
  output_config?: { effort: 'low' | 'medium' | 'high' };
}

async function anthropicToolLoop(
  params: AnthropicToolLoopParams,
  toolImpls: Record<string, (args: any) => Promise<any>> = {},
): Promise<Array<{ type: string; text?: string; content?: string }>> {
  const {
    model = 'claude-sonnet-5',
    max_output_tokens = 16384,
    system,
    userMessage,
    conversationHistory,
    tools: openaiTools,
    onTurn,
    label,
    maxTurns,
    signal,
    thinking,
    output_config,
  } = params;

  const anthropicTools = convertToolDefinitions(openaiTools);

  const resolvedThinking = resolveThinkingConfig({
    model,
    thinking,
    outputConfig: output_config,
    maxOutputTokens: max_output_tokens,
  });

  const systemMessages: Anthropic.MessageCreateParams['system'] =
    typeof system === 'string'
      ? [
          {
            type: 'text' as const,
            text: system,
            cache_control: { type: 'ephemeral' as const },
          },
        ]
      : system.map((block) => ({
          type: 'text' as const,
          text: block.text,
          ...(block.cacheControl === 'ephemeral'
            ? { cache_control: { type: 'ephemeral' as const } }
            : {}),
        }));

  const messages: Anthropic.MessageParam[] = [
    ...(conversationHistory ?? []).map((msg) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    })),
    // Skip empty user message (e.g. handoff re-entry where referral is already in history)
    ...(userMessage ? [{ role: 'user' as const, content: userMessage }] : []),
  ];

  const MAX_MESSAGE_CHARS = 400_000; // ~100K tokens — leave headroom for system prompt + output

  // A tool call cut off mid-JSON returns nothing the loop can act on. We tell
  // the model its call was truncated and ask for a smaller one — but only so
  // many times: if it can't get under the ceiling in two consecutive tries,
  // that's a real failure and must be raised, not returned as an empty answer.
  const MAX_TRUNCATION_RECOVERIES = 2;
  let truncationRecoveries = 0;

  for (let turn = 0; ; turn++) {
    if (signal?.aborted) throw new Error('Aborted');

    if (maxTurns !== undefined && turn >= maxTurns) {
      logger.error('[anthropic] tool loop hit maxTurns', { turn, maxTurns, model, label });
      throw new Error(
        `Anthropic tool loop exhausted its turn budget (maxTurns=${maxTurns})${
          label ? ` in ${label}` : ''
        } — the agent never finished.`,
      );
    }

    const llmStart = Date.now();

    const response = await enqueueQuery(async () => {
      return platformAnthropic().messages.create(
        {
          model,
          max_tokens: max_output_tokens,
          system: systemMessages,
          tools: anthropicTools,
          messages: withFinalCacheBreakpoint(messages),
          ...(resolvedThinking.thinking ? { thinking: resolvedThinking.thinking } : {}),
          ...(resolvedThinking.output_config
            ? { output_config: resolvedThinking.output_config }
            : {}),
        } as Anthropic.MessageCreateParams,
        { signal },
      );
    }, signal);

    const llmMs = Date.now() - llmStart;

    const textBlocks: string[] = [];
    const toolUseBlocks: Anthropic.ToolUseBlock[] = [];
    const thinkingBlocks: string[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textBlocks.push(block.text);
      } else if (block.type === 'tool_use') {
        toolUseBlocks.push(block);
      } else if (block.type === 'thinking') {
        // Extended-thinking content block. Captured separately from
        // visible-to-user text so the M2 runner can persist it onto
        // `agent_message.metadata.thoughts.thinking`.
        thinkingBlocks.push((block as { thinking: string }).thinking);
      }
    }

    const thinkingText = textBlocks.length > 0 ? textBlocks.join('\n') : null;
    const extendedThinking = thinkingBlocks.length > 0 ? thinkingBlocks.join('\n') : null;
    const usage = response.usage;

    // `max_tokens` with no text is the silent-death case: a tool call that ran
    // out of budget mid-JSON is dropped from `content`, so the turn carries
    // neither an executable call nor an answer.
    const truncated: TurnEvent['truncated'] =
      response.stop_reason === 'max_tokens'
        ? textBlocks.length > 0
          ? 'text'
          : 'no_output'
        : undefined;

    const event: TurnEvent = {
      turn,
      thinkingText,
      extendedThinking,
      toolNames: toolUseBlocks.map((b) => b.name),
      llmMs,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      ...(truncated ? { truncated } : {}),
    };

    logger.info('[anthropic] turn', {
      turn,
      model,
      stop_reason: response.stop_reason,
      ...(truncated ? { truncated } : {}),
      llmMs,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      thinkingText: thinkingText ? thinkingText.slice(0, 500) : null,
      toolNames: toolUseBlocks.map((b) => b.name),
    });

    onTurn?.(event);

    recordLlmUsage({
      provider: 'anthropic',
      model,
      callType: 'tool_loop',
      label,
      inputTokens: event.inputTokens,
      outputTokens: event.outputTokens,
      cacheReadTokens: event.cacheReadTokens,
      cacheCreationTokens: event.cacheCreationTokens,
      durationMs: event.llmMs,
    }).catch(() => {});

    if (response.stop_reason === 'tool_use' && toolUseBlocks.length > 0) {
      truncationRecoveries = 0;
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
        toolUseBlocks.map(async (tc) => {
          if (signal?.aborted)
            return { type: 'tool_result' as const, tool_use_id: tc.id, content: 'Aborted' };
          const tool = toolImpls[tc.name];
          let result;
          if (tool) {
            try {
              result = await tool(tc.input as any);
            } catch (e: any) {
              // Re-throw control-flow signals (e.g. handoff/hand-back) — they must propagate
              if (e?.isHandoff || e?.isHandBack) throw e;
              result = { error: String(e) };
            }
          } else {
            result = { error: `Tool ${tc.name} not found` };
          }

          return {
            type: 'tool_result' as const,
            tool_use_id: tc.id,
            content: JSON.stringify(result),
          };
        }),
      );

      if (signal?.aborted) throw new Error('Aborted');

      messages.push({ role: 'user', content: toolResults });

      // Compact old tool results once the run gets genuinely large, recovering
      // enough to drop back under a comfortable working ceiling — "compaction by
      // omission". Opus's 1M window means we can let a build accumulate real
      // context (schemas read, plan, completions) before trimming, instead of
      // forgetting after a handful of tool turns. We use the API's own token
      // count rather than re-serializing.
      //   COMPACT_TRIGGER_TOKENS — let context grow this far before trimming.
      //   COMPACT_TARGET_TOKENS  — trim back down to roughly this.
      // Cache note: rewriting old blocks changes the prompt prefix, so a
      // compaction costs one full cache re-write. Raising the trigger means it
      // fires far more rarely (most sessions never reach it → fully append-only,
      // cache-friendly); when it does fire it recovers a lot at once. ~4 chars
      // per token converts the token gap into a char-recovery goal.
      const COMPACT_TRIGGER_TOKENS = 500_000;
      const COMPACT_TARGET_TOKENS = 200_000;
      if (usage.input_tokens > COMPACT_TRIGGER_TOKENS) {
        const targetRecoverChars = (usage.input_tokens - COMPACT_TARGET_TOKENS) * 4;
        let recovered = 0;
        // Walk oldest→newest, skip the most recent tool_result (just appended)
        for (let i = 0; i < messages.length - 1; i++) {
          const msg = messages[i];
          if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
          for (const block of msg.content) {
            if (
              typeof block === 'object' &&
              'type' in block &&
              block.type === 'tool_result' &&
              typeof block.content === 'string' &&
              block.content.length > 200
            ) {
              recovered += block.content.length;
              (block as Anthropic.ToolResultBlockParam).content =
                '[Compacted — re-query if needed.]';
            }
          }
          if (recovered >= targetRecoverChars) break;
        }
        if (recovered > 0) {
          logger.info('[anthropic] compacted old tool results', {
            recoveredChars: recovered,
            inputTokens: usage.input_tokens,
          });
        }
      }
    } else if (truncated === 'text') {
      // Response was truncated — feed partial output back and ask to continue
      truncationRecoveries = 0;
      logger.info('[anthropic] tool loop response truncated, continuing', { turn });
      const partialText = textBlocks.join('\n');
      messages.push({ role: 'assistant', content: partialText });
      messages.push({ role: 'user', content: 'Continue exactly where you left off.' });
    } else if (truncated === 'no_output') {
      // The turn died mid-tool-call: nothing ran and nothing was said. Falling
      // through here returns [] and ends the run in silence, so instead we say
      // what happened and ask for a smaller step.
      truncationRecoveries += 1;
      if (truncationRecoveries > MAX_TRUNCATION_RECOVERIES) {
        logger.error('[anthropic] tool loop truncated repeatedly, giving up', {
          turn,
          model,
          label,
          recoveries: truncationRecoveries - 1,
          maxOutputTokens: max_output_tokens,
        });
        throw new Error(
          `Anthropic tool loop truncated at max_tokens (${max_output_tokens}) before emitting a usable tool call, ${
            MAX_TRUNCATION_RECOVERIES
          } recoveries in a row${label ? ` in ${label}` : ''}.`,
        );
      }

      logger.warn('[anthropic] tool loop truncated mid-tool-call, asking for a smaller step', {
        turn,
        model,
        label,
        recovery: truncationRecoveries,
        maxOutputTokens: max_output_tokens,
      });
      messages.push({
        role: 'assistant',
        content: '[Reply cut off at the output token limit before anything was emitted.]',
      });
      messages.push({
        role: 'user',
        content:
          'Your last reply hit the output token limit before it finished a tool call, so nothing ran and nothing reached me. Redo that step as a smaller tool call — less text in the arguments, and split the work across several calls if you need to.',
      });
    } else {
      return textBlocks.map((text) => ({ type: 'text', text }));
    }
  }
}

const MAX_CHAT_CONTINUATIONS = 5;

/** How long one Messages request may run before the wait itself is news. Silence
 *  for longer than this is indistinguishable from a hang to anyone watching the
 *  logs, which is exactly how a 7½-minute extraction read as a dead process. */
const SLOW_CALL_WARN_MS = 60 * SECOND;

interface AnthropicChatOptions {
  system: string;
  userMessage: string;
  model?: Anthropic.Messages.Model;
  maxTokens?: number;
  label?: string;
  noContinue?: boolean;
  temperature?: number;
  prefill?: string;
  /**
   * Reasoning depth for the models that reason by DEFAULT. Sonnet 5 and the
   * Opus 4.6+ family think adaptively when `thinking` is omitted, at effort
   * `high` — so a caller that never mentions thinking still buys the deepest
   * setting, and pays for it in output tokens it never asked for. Naming an
   * effort here is how a caller says how much reasoning its job is worth.
   *
   * Ignored on the budget-dialect models (Haiku, legacy Sonnet 4.x), which do
   * not accept `output_config` and do not think unless explicitly told to.
   *
   * `xhigh` sits between `high` and `max` (Opus 4.7+, Sonnet 5) — this SDK's
   * pinned version types `output_config.effort` without it, so it crosses
   * into the raw request via an assertion below rather than a plain field.
   */
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
  /** Ceiling on continue-where-you-left-off turns after a `max_tokens` stop.
   *  Defaults to {@link MAX_CHAT_CONTINUATIONS}. Lower it where a long reply is
   *  more likely to be a runaway than a real answer — each continuation buys
   *  another whole `maxTokens` of output. */
  maxContinuations?: number;
  /** BYOT — the team's own Anthropic key (pricing-v2 §B.2). Absent ⇒ platform key. */
  apiKey?: string;
}

/**
 * Models that read `output_config: { effort }` and think adaptively when
 * `thinking` is omitted. Mirrors {@link resolveThinkingConfig}'s family split —
 * the budget-dialect models (Haiku, legacy Sonnet 4.x) reject `output_config`
 * outright and start from no thinking at all, so there is nothing to bound.
 */
function usesAdaptiveThinking(model: string): boolean {
  return (
    model.startsWith('claude-opus') ||
    model.startsWith('claude-sonnet-5') ||
    model.startsWith('claude-fable') ||
    model.startsWith('claude-mythos')
  );
}

/**
 * Announce a call that is STILL RUNNING once it passes the slow threshold, and
 * again with its duration when it lands. The in-flight line is the one that
 * matters: a completion log, however detailed, says nothing during the wait it
 * is describing. Returns the settle callback.
 */
function watchSlowCall(fields: Record<string, unknown>): (outcome: 'ok' | 'error') => void {
  const startMs = Date.now();
  const timer = setTimeout(() => {
    logger.warn('[anthropic] chat still running', { ...fields, afterMs: SLOW_CALL_WARN_MS });
  }, SLOW_CALL_WARN_MS);
  // Never let a pending warning be the reason the process stays alive.
  timer.unref?.();
  return (outcome) => {
    clearTimeout(timer);
    const durationMs = Date.now() - startMs;
    if (durationMs >= SLOW_CALL_WARN_MS) {
      logger.warn('[anthropic] chat slow', { ...fields, durationMs, outcome });
    }
  };
}

/**
 * A chat reply WITH the boundary facts a caller needs to judge it. The bare
 * string surface throws these away, which is how a truncated reply reaches a
 * lenient JSON salvage and comes out validating with half its fields nulled.
 */
interface ChatReply {
  text: string;
  stopReason: Anthropic.StopReason | null;
  /** The loop ran out of road while still truncated — continuations exhausted,
   *  `noContinue`, or the text-free bail. The text is a fragment. */
  truncated: boolean;
}

async function anthropicChatDetailed(options: AnthropicChatOptions): Promise<ChatReply> {
  const {
    system,
    userMessage,
    model = 'claude-sonnet-5',
    maxTokens = 16384,
    label,
    noContinue = false,
    temperature,
    prefill,
    effort,
    maxContinuations = MAX_CHAT_CONTINUATIONS,
    apiKey: byotApiKey,
  } = options;
  const client = clientFor(byotApiKey);

  // Adaptive thinking is ON by default on these models; the only lever a chat
  // caller has over its depth is `effort`, and it only lands if `thinking` is
  // sent alongside it.
  const thinkingConfig =
    effort && usesAdaptiveThinking(model)
      ? { thinking: { type: 'adaptive' as const }, output_config: { effort } }
      : {};

  const requestId = randomUUID().slice(0, 8);
  const callFields = { label, model, requestId, ...runFields() };
  const callStartMs = Date.now();

  const systemBlock = [
    { type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } },
  ];
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
    ...(prefill ? [{ role: 'assistant' as const, content: prefill }] : []),
  ];

  let accumulated = prefill ?? '';
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheCreationTokens = 0;
  let stopReason: Anthropic.StopReason | null = null;
  let contentBlockTypes: string[] = [];

  for (let turn = 0; turn <= maxContinuations; turn++) {
    logger.info('[anthropic] chat starting', { ...callFields, turn, maxTokens, effort });

    const settleWatch = watchSlowCall({ ...callFields, turn });
    let response: Anthropic.Message;
    try {
      // Streamed rather than awaited whole: above ~16K `max_tokens` a
      // non-streaming request outlives the SDK's HTTP timeout. `finalMessage()`
      // reassembles the same `Message`, so nothing downstream changes.
      response = await enqueueQuery(async () => {
        const stream = client.messages.stream({
          model,
          max_tokens: maxTokens,
          system: systemBlock,
          messages,
          ...thinkingConfig,
          ...(temperature != null && { temperature }),
          // `effort: 'xhigh'` is a real value this SDK's pinned types predate
          // (its `OutputConfig.effort` union stops at `'max'`) — same
          // stale-type crossing `anthropicToolLoop` already does above.
        } as Anthropic.MessageCreateParamsStreaming);
        return stream.finalMessage();
      });
    } catch (error) {
      settleWatch('error');
      throw error;
    }
    settleWatch('ok');

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    accumulated += text;
    totalInputTokens += response.usage.input_tokens;
    totalOutputTokens += response.usage.output_tokens;
    totalCacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    totalCacheCreationTokens += response.usage.cache_creation_input_tokens ?? 0;
    stopReason = response.stop_reason;
    contentBlockTypes = response.content.map((b) => b.type);

    if (response.stop_reason !== 'max_tokens' || noContinue) break;

    // Truncated *before* any text — the whole budget went on thinking, so there
    // is nothing to continue from. The continuation below would push an empty
    // assistant turn, which the API rejects (text blocks must be non-empty),
    // turning a thin reply into four retries and a 400.
    if (text === '') break;

    if (turn === maxContinuations) break;

    logger.info('[anthropic] chat truncated, continuing', { ...callFields, turn: turn + 1 });

    // Feed partial output back as assistant turn, ask to continue
    messages.push({ role: 'assistant', content: text });
    messages.push({ role: 'user', content: 'Continue exactly where you left off.' });
  }

  const durationMs = Date.now() - callStartMs;

  logger.info('[anthropic] chat', {
    ...callFields,
    stopReason,
    durationMs,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
  });

  // A text-free reply is a real outcome, not an anomaly: `refusal` returns 200
  // with no content, and an adaptive-thinking model that exhausts `maxTokens`
  // thinking returns only a (display-omitted) thinking block. Callers see `''`
  // either way, so name the cause here — downstream this surfaces as an opaque
  // parse failure with nothing pointing back at the model.
  if (accumulated === '') {
    logger.warn('[anthropic] chat returned no text', {
      ...callFields,
      stopReason,
      contentBlockTypes,
      maxTokens,
      durationMs,
    });
  }

  recordLlmUsage({
    provider: 'anthropic',
    model,
    callType: 'chat',
    label,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
  }).catch(() => {});

  return { text: accumulated, stopReason, truncated: stopReason === 'max_tokens' };
}

/**
 * Chat reply plus its boundary facts. Use this — not {@link anthropicChat} —
 * whenever a truncated reply would be indistinguishable from a complete one
 * downstream (a JSON body a lenient parser will happily salvage, say).
 */
/** The bare-text surface. */
async function anthropicChat(options: AnthropicChatOptions): Promise<string> {
  return (await anthropicChatDetailed(options)).text;
}

interface AnthropicChatStructuredOptions<T> {
  system: string;
  userMessage: string;
  /** Object-rooted schema — Anthropic tool inputs are always objects. */
  schema: z.ZodType<T>;
  /** Tool name the model is forced to call. */
  toolName: string;
  toolDescription: string;
  model?: Anthropic.Messages.Model;
  maxTokens?: number;
  label?: string;
  /** BYOT key (pricing-v2 §B.2). Never part of the recording hash. */
  apiKey?: string;
}

/**
 * Structured Anthropic output via a single forced tool call. Returns a
 * schema-validated object; raises rather than silently dropping on a missing
 * tool call or invalid input (see {@link StructuredOutputError}).
 */
async function anthropicChatStructured<T>(
  options: AnthropicChatStructuredOptions<T>,
): Promise<T> {
  const {
    system,
    userMessage,
    schema,
    toolName,
    toolDescription,
    model = 'claude-sonnet-5',
    maxTokens = 4096,
    label,
    apiKey: byotApiKey,
  } = options;

  const client = clientFor(byotApiKey);
  const tool = buildStructuredTool({ name: toolName, description: toolDescription, schema });

  const startMs = Date.now();
  const response: Anthropic.Message = await enqueueQuery(async () =>
    client.messages.create({
      model,
      max_tokens: maxTokens,
      system: [{ type: 'text' as const, text: system, cache_control: { type: 'ephemeral' as const } }],
      messages: [{ role: 'user', content: userMessage }],
      tools: [tool],
      tool_choice: { type: 'tool', name: toolName },
    }),
  );
  const durationMs = Date.now() - startMs;

  recordLlmUsage({
    provider: 'anthropic',
    model,
    callType: 'structured',
    label,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
    cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
    cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
    durationMs,
  }).catch(() => {});

  return extractStructuredResult({ response, toolName, schema });
}

export {
  anthropicToolLoop,
  anthropicChat,
  anthropicChatDetailed,
  anthropicChatStructured,
  MAX_CHAT_CONTINUATIONS,
};
export { StructuredOutputError } from './structured';
export type {
  TurnEvent,
  AnthropicToolLoopParams,
  AnthropicChatOptions,
  AnthropicChatStructuredOptions,
  ChatReply,
};
