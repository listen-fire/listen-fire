/**
 * Pure transform between the orchestration DSL (the stored source of
 * truth) and the linear effect-list model the in-place editor edits.
 *
 * The editor only understands *linear* composition — a single effect, or
 * a flat fan_out whose children are all plain `run_tg` steps. Anything
 * richer (branches, nested fan_outs, a `run_tg` carrying a `then` chain,
 * mixed fan_out children) is reported as `unsupported` so the editor can
 * decline to edit it rather than flattening and destroying it on save.
 *
 */

export type OrchStep =
  | { kind: 'run_tg'; tgId: string; then?: OrchStep }
  | { kind: 'fan_out'; mode: 'parallel' | 'series'; children: OrchStep[] }
  | { kind: 'branch'; expr: unknown; arms: Record<string, OrchStep>; default?: OrchStep };

// `chain` = pipe each step's output into the next (nested `.then`) — the
// composition case (Email → shape → Attio). `parallel`/`series` are fan_out
// modes (each step reads the same source, run together / in order).
export type OrchMode = 'parallel' | 'series' | 'chain';

/** A linear sub-program: an ordered/unordered list of plain effects. */
export type LinearProgram = { effects: string[]; mode: OrchMode };

export type ParsedOrchestration =
  | { kind: 'linear'; effects: string[]; mode: OrchMode }
  /**
   * A boolean branch: `if <condition>` run `then`, `otherwise` run the
   * default. Modelled as a `branch` whose `expr` is a boolean condition,
   * a single `'true'` arm, and an optional `default`. `condition` is the
   * opaque Output-v3 expression (carried through verbatim).
   */
  | { kind: 'branch'; condition: unknown; then: LinearProgram; otherwise: LinearProgram }
  | { kind: 'unsupported' }
  | { kind: 'empty' };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A plain terminal effect: `{ kind: 'run_tg', tgId }` with no `then`
 * chain. Returns the tgId when the shape matches, otherwise null.
 */
function plainRunTgId(value: unknown): string | null {
  if (!isObject(value)) return null;
  if (value.kind !== 'run_tg') return null;
  if (typeof value.tgId !== 'string') return null;
  if (value.then !== undefined) return null;
  return value.tgId;
}

/**
 * Parse a step into the linear { effects, mode } shape, or null if it
 * isn't linear (a single plain run_tg, or a flat fan_out of plain
 * run_tgs).
 */
function parseLinearShape(raw: unknown): LinearProgram | null {
  if (!isObject(raw)) return null;
  if (raw.kind === 'run_tg') {
    // A `.then` chain — each step pipes into the next.
    if (raw.then !== undefined) {
      const effects: string[] = [];
      let cur: unknown = raw;
      while (isObject(cur) && cur.kind === 'run_tg' && typeof cur.tgId === 'string') {
        effects.push(cur.tgId);
        cur = cur.then;
      }
      // The chain must terminate cleanly (a run_tg with no `then`); anything
      // else in the tail (fan_out / branch) is richer than the editor models.
      if (cur !== undefined) return null;
      return { effects, mode: 'chain' };
    }
    const tgId = plainRunTgId(raw);
    return tgId === null ? null : { effects: [tgId], mode: 'parallel' };
  }
  if (raw.kind === 'fan_out') {
    const mode = raw.mode;
    if (mode !== 'parallel' && mode !== 'series') return null;
    if (!Array.isArray(raw.children)) return null;
    const effects: string[] = [];
    for (const child of raw.children) {
      const tgId = plainRunTgId(child);
      if (tgId === null) return null;
      effects.push(tgId);
    }
    return { effects, mode };
  }
  return null;
}

export function parseOrchestration(raw: unknown): ParsedOrchestration {
  if (raw === null || raw === undefined) return { kind: 'empty' };
  if (!isObject(raw)) return { kind: 'unsupported' };

  if (raw.kind === 'run_tg' || raw.kind === 'fan_out') {
    const linear = parseLinearShape(raw);
    return linear ? { kind: 'linear', ...linear } : { kind: 'unsupported' };
  }

  // A boolean branch: exactly a `'true'` arm (the "if" body) + an
  // optional `default` (the "otherwise"), each a linear sub-program. Any
  // other arm shape (extra keys, non-linear arms) is left to the
  // assistant — we decline rather than misrepresent it.
  if (raw.kind === 'branch') {
    const arms = raw.arms;
    if (!isObject(arms)) return { kind: 'unsupported' };
    const armKeys = Object.keys(arms);
    if (armKeys.length !== 1 || armKeys[0] !== 'true') return { kind: 'unsupported' };
    const thenProg = parseLinearShape(arms.true);
    if (!thenProg) return { kind: 'unsupported' };
    let otherwise: LinearProgram = { effects: [], mode: 'parallel' };
    if (raw.default !== undefined) {
      const elseProg = parseLinearShape(raw.default);
      if (!elseProg) return { kind: 'unsupported' };
      otherwise = elseProg;
    }
    return { kind: 'branch', condition: raw.expr, then: thenProg, otherwise };
  }

  return { kind: 'unsupported' };
}

export function buildOrchestration(effects: string[], mode: OrchMode): OrchStep | null {
  if (effects.length === 0) return null;
  if (effects.length === 1) return { kind: 'run_tg', tgId: effects[0] };
  if (mode === 'chain') {
    // Nest right-to-left so the first effect is the outermost run_tg and each
    // `.then` pipes into the next; the last carries no `then`.
    let step: OrchStep | undefined;
    for (let i = effects.length - 1; i >= 0; i--) {
      step = { kind: 'run_tg', tgId: effects[i], ...(step ? { then: step } : {}) };
    }
    return step ?? null;
  }
  return {
    kind: 'fan_out',
    mode,
    children: effects.map((tgId) => ({ kind: 'run_tg', tgId })),
  };
}

/**
 * Build a boolean-branch orchestration: `if <condition>` run `then`,
 * `otherwise` run the default. Returns null when the `then` body is
 * empty (a branch with nothing to do when true is meaningless). The
 * `otherwise` is omitted when empty (false → no default → no-op).
 */
export function buildBranchOrchestration(
  condition: unknown,
  then: LinearProgram,
  otherwise: LinearProgram,
): OrchStep | null {
  const thenStep = buildOrchestration(then.effects, then.mode);
  if (!thenStep) return null;
  const elseStep = buildOrchestration(otherwise.effects, otherwise.mode);
  return {
    kind: 'branch',
    expr: condition,
    arms: { true: thenStep },
    ...(elseStep ? { default: elseStep } : {}),
  };
}
