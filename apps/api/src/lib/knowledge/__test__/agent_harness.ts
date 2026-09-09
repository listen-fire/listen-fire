/**
 * Agent test harness.
 *
 * Lets a test drive an agent runner (runSetupAgent, runTranslationAgent,
 * etc.) deterministically by:
 *
 *  1. Mocking the underlying LLM call (`anthropicToolLoop` or
 *     `openAIResponses`) with a scripted sequence of turns.
 *  2. Capturing every tool the LLM "calls" during the loop, with the
 *     args, in order.
 *  3. Asserting both the final assistant text and the tool-call
 *     sequence after the runner returns.
 *
 * The harness is provider-agnostic — tests script "turns" at a high
 * level and the harness installs the appropriate fake for whichever
 * provider the agent is running under.
 *
 * Usage (see setup_agent.unit.test.ts for the full pattern):
 *
 *   const harness = installAgentHarness();
 *   harness.scriptTurns([
 *     { toolCalls: [{ name: 'handoff', args: { to: 'translation', referral: '...' } }] },
 *     { text: 'final reply to user' },
 *   ]);
 *   const result = await runSetupAgent('hi', { teamId: 't1' });
 *   expect(harness.toolCalls).toEqual([{ name: 'handoff', args: ... }]);
 *
 * Establishing chunk: S1 (Setup agent skeleton). Reused by S2, T1, D1,
 * A1, D2 where chat-level testing is needed.
 */

import { HandoffSignal, HandBackSignal } from '../handoff';

// ---------------------------------------------------------------------------
// Turn script types
// ---------------------------------------------------------------------------

export interface ScriptedToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface ScriptedTurn {
  /** Tool calls to invoke this turn (in order). */
  toolCalls?: ScriptedToolCall[];
  /** Assistant text emitted this turn (terminates the loop). */
  text?: string;
  /**
   * Extended-thinking content the scripted Anthropic turn should
   * "emit". When set, the fake `anthropicToolLoop` calls the
   * provider's `onTurn` callback with this content as the
   * `extendedThinking` field so the runner accumulates it the same
   * way it would from a real Anthropic response with `thinking:
   * { type: 'enabled' }`. No effect on the OpenAI path.
   *
   * Added by M2 (agent-memory-persistence) so the runner's thoughts-
   * persistence path can be tested deterministically.
   */
  extendedThinking?: string;
}

// ---------------------------------------------------------------------------
// Captured tool call record (for assertions)
// ---------------------------------------------------------------------------

export interface RecordedToolCall {
  name: string;
  args: Record<string, unknown>;
  /** Result the tool returned (or thrown signal name). */
  result: unknown;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export interface AgentHarness {
  /** Provide the scripted sequence of turns. */
  scriptTurns: (turns: ScriptedTurn[]) => void;
  /** Tool calls captured in the order they were invoked. */
  toolCalls: RecordedToolCall[];
  /** The handoff signal that was thrown (if any) — caught here so tests
   *  can assert on it without the test runner treating it as a failure. */
  caughtHandoff: HandoffSignal | null;
  caughtHandBack: HandBackSignal | null;
  /** Reset captured state between tests. */
  reset: () => void;
}

/**
 * Install the harness. Call ONCE at module load (before importing the
 * agent under test). The returned object collects state per test; call
 * `reset()` in `beforeEach`.
 *
 * Wires up jest.mock() for the LLM provider modules. Because jest.mock()
 * needs to run at the top of the test file, the harness exposes the
 * mock targets as exported `__mocks__` for the test file to register.
 */
export function createAgentHarness(): AgentHarness {
  const state: {
    scripted: ScriptedTurn[];
    turnIndex: number;
    toolCalls: RecordedToolCall[];
    caughtHandoff: HandoffSignal | null;
    caughtHandBack: HandBackSignal | null;
  } = {
    scripted: [],
    turnIndex: 0,
    toolCalls: [],
    caughtHandoff: null,
    caughtHandBack: null,
  };

  return {
    scriptTurns(turns) {
      state.scripted = turns;
      state.turnIndex = 0;
    },
    get toolCalls() {
      return state.toolCalls;
    },
    get caughtHandoff() {
      return state.caughtHandoff;
    },
    get caughtHandBack() {
      return state.caughtHandBack;
    },
    reset() {
      state.scripted = [];
      state.turnIndex = 0;
      state.toolCalls = [];
      state.caughtHandoff = null;
      state.caughtHandBack = null;
    },
    // Internal — used by the mock fakes below to drive the loop.
    ...({ __state: state } as any),
  };
}

/**
 * The fake `anthropicToolLoop` / `openAIResponses` implementations. Both
 * walk the scripted turn list, invoke any tool implementations the
 * runner passed in (so handoff signals propagate naturally), and
 * return the final text turn's content.
 *
 * Behaviour:
 *  - Each scripted turn with `toolCalls` invokes each tool in order via
 *    the runner-supplied implementations. The result (or thrown signal)
 *    is recorded. Handoff / hand-back signals propagate.
 *  - The first scripted turn with `text` ends the loop and that text
 *    becomes the LLM "output". Returns the AgentResponseSchema-shaped
 *    array.
 *  - If the script runs out before producing text, returns empty.
 */
export function makeFakeProvider(harness: AgentHarness) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const state = (harness as any).__state as {
    scripted: ScriptedTurn[];
    turnIndex: number;
    toolCalls: RecordedToolCall[];
    caughtHandoff: HandoffSignal | null;
    caughtHandBack: HandBackSignal | null;
  };

  /**
   * Drive the scripted turns.
   *
   * `onTurn` is the Anthropic-loop callback the runner installs to
   * receive per-turn TurnEvent updates (thinking text + extended
   * thinking + tool names). The fake fires it once per scripted turn
   * with a minimal synthetic event so tests of the runner's thoughts-
   * persistence path see the same shape they would in production.
   * Pass null on the OpenAI path (no equivalent callback).
   */
  const drive = async (
    toolImpls: Record<string, (args: any) => Promise<unknown>>,
    onTurn: ((event: {
      turn: number;
      thinkingText: string | null;
      extendedThinking: string | null;
      toolNames: string[];
      llmMs: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }) => void) | null,
  ): Promise<Array<{ type: string; text?: string }>> => {
    for (; state.turnIndex < state.scripted.length; state.turnIndex += 1) {
      const turn = state.scripted[state.turnIndex];

      onTurn?.({
        turn: state.turnIndex,
        thinkingText: null,
        extendedThinking: turn.extendedThinking ?? null,
        toolNames: (turn.toolCalls ?? []).map((tc) => tc.name),
        llmMs: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
      });

      if (turn.toolCalls) {
        for (const tc of turn.toolCalls) {
          const impl = toolImpls[tc.name];
          if (!impl) {
            state.toolCalls.push({ name: tc.name, args: tc.args, result: { error: 'no impl' } });
            continue;
          }
          try {
            const result = await impl(tc.args);
            state.toolCalls.push({ name: tc.name, args: tc.args, result });
          } catch (err: unknown) {
            if (err instanceof HandoffSignal) {
              state.caughtHandoff = err;
              state.toolCalls.push({ name: tc.name, args: tc.args, result: { handoff: err.to } });
              throw err;
            }
            if (err instanceof HandBackSignal) {
              state.caughtHandBack = err;
              state.toolCalls.push({ name: tc.name, args: tc.args, result: { handBack: true } });
              throw err;
            }
            state.toolCalls.push({ name: tc.name, args: tc.args, result: { error: String(err) } });
          }
        }
      }

      if (turn.text !== undefined) {
        state.turnIndex += 1;
        return [{ type: 'text', text: turn.text }];
      }
    }
    return [];
  };

  return {
    anthropicToolLoop: async (
      params: { onTurn?: (event: any) => void } | unknown,
      toolImpls: Record<string, (args: any) => Promise<unknown>> = {},
    ) => drive(toolImpls, (params as { onTurn?: (event: any) => void })?.onTurn ?? null),
    openAIResponses: async (
      _body: unknown,
      toolImpls: Record<string, (args: any) => Promise<unknown>> = {},
    ) => drive(toolImpls, null),
  };
}
