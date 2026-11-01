// Config blocks: the declarative, host-rendered configuration UI an adapter
// publishes for its construction role. A `ConfigBlock` is a closed,
// kind-discriminated union; the host (editor, chat) walks the list and renders
// each block by its `kind` with no per-adapter UI hardcoding: an ordered list
// of blocks, some collecting values, some presenting text, some dispatching
// actions. The same declaration validates the values server-side
// (`zodFromConfigBlocks`). `kind` is internal vocabulary, never a rendered
// string.
//
// Kept free of any import from `./adapter` so the interface can import the
// type without a cycle.

import { z } from 'zod';

import { neverAsAny } from 'movement-lang';

/** A slug's charset: lowercase alphanumerics in hyphen-separated runs. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ── Value blocks ────────────────────────────────────────────────────────────
// Collect a value, carry a `key`: the binding to a config slot. The same
// object the host renders is the one the validator reads and the one that
// names where the value persists.

/**
 * Free-text / slug value collection. `text` and `slug` share a field set and
 * differ only in validation; the validator branches on `kind`.
 *
 *   - `text` — free text
 *   - `slug` — text constrained to {@link SLUG_PATTERN}; may carry
 *              `prefix`/`suffix` the UI shows around the input (the local
 *              part and the domain of the deployment's own inbound address) so
 *              the user reads the whole address while editing
 *              only the variable part
 */
export interface TextBlock {
  kind: 'text' | 'slug';
  /** Key of the value this block reads and writes. */
  key: string;
  /** User-facing label. No substrate jargon. */
  label: string;
  help?: string;
  placeholder?: string;
  /** Static text shown immediately before the input (display only). */
  prefix?: string;
  /** Static text shown immediately after the input (display only). */
  suffix?: string;
  required?: boolean;
  min?: number;
  max?: number;
}

/** One-of-a-fixed-set value collection. */
interface SelectBlock {
  kind: 'select';
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  options: ReadonlyArray<{ value: string; label: string }>;
}

// ── Presentation blocks ─────────────────────────────────────────────────────

/**
 * Presentational — a `title` and/or `text` body, optional `tone`. Carries no
 * `key` and collects nothing. This is what lets a rich config read as framing
 * prose plus a field, rather than text subordinated to a single input's `help`. The minimum presentational
 * primitive — no divider/image/link until a real need appears.
 */
interface SectionBlock {
  kind: 'section';
  title?: string;
  text?: string;
  /** Styling hint — `'info'` (framing prose) or `'note'` (a quieter aside). */
  tone?: 'info' | 'note';
}

// ── Action blocks ───────────────────────────────────────────────────────────

/**
 * Dispatches to an APP-SHIPPED handler by `kind`, rendering `label` (and an
 * optional `help` line). Carries no value. This IS the former `ConnectAction`
 * (`{ kind, label }`) promoted into the block union: when the host renders an
 * action block it wires the affordance to `runConnectAction(kind, ctx)` — the
 * exact same registry dispatch the editor and chat use today. Declaration is
 * portable (any adapter, local or remote); behaviour is app-shipped (Principle
 * 5), so a remote adapter may only reference a `kind` the app already ships.
 */
interface ActionBlock {
  kind: 'action';
  /** App-shipped client handler id, e.g. `'google-drive-picker'`. The
   *  framework never interprets this — the host routes it to its handler
   *  registry. */
  actionKind: string;
  /** Button / affordance text shown to the author. No internal jargon. */
  label: string;
  help?: string;
}

/**
 * The closed config-block union. Three families:
 *   - VALUE blocks ({@link TextBlock} `text`/`slug`, {@link SelectBlock}) —
 *     collect a value, carry a `key`;
 *   - PRESENTATION blocks ({@link SectionBlock}) — render text, no `key`;
 *   - ACTION blocks ({@link ActionBlock}) — dispatch to an app handler, no `key`.
 *
 * Discriminated on `kind`; the host's only branching is on `block.kind`. An
 * adapter cannot invent a rendered widget — it composes from this vocabulary.
 */
export type ConfigBlock = TextBlock | SelectBlock | SectionBlock | ActionBlock;

/** The VALUE-block subset of {@link ConfigBlock}: the blocks that carry a
 *  `key` and collect a value. */
type ValueBlock = TextBlock | SelectBlock;

/** Narrow a {@link ConfigBlock} to a value block (carries a `key`). */
export function isValueBlock(block: ConfigBlock): block is ValueBlock {
  return block.kind === 'text' || block.kind === 'slug' || block.kind === 'select';
}

// ── Validation ──────────────────────────────────────────────────────────────

function zodForValueBlock(block: ValueBlock): z.ZodTypeAny {
  if (block.kind === 'select') {
    const values = block.options.map((o) => o.value);
    const base =
      values.length > 0
        ? z.enum(values as [string, ...string[]])
        : z.string();
    return block.required ? base : base.optional();
  }

  let str = z.string();
  if (block.kind === 'slug') {
    str = str.regex(
      SLUG_PATTERN,
      'Use lowercase letters, numbers, and hyphens only.',
    );
  }
  if (typeof block.min === 'number') {
    str = str.min(block.min, `Must be at least ${block.min} character(s).`);
  }
  if (typeof block.max === 'number') {
    str = str.max(block.max, `Must be at most ${block.max} character(s).`);
  }
  if (block.required) {
    // A required text/slug block rejects empty/whitespace-only input even
    // when no explicit `min` is set.
    return str.min(block.min ?? 1, 'This field is required.');
  }
  return str.optional();
}

/**
 * Build a Zod object validating the values described by `blocks`. Walks only VALUE blocks; presentation (`section`) and
 * action (`action`) blocks have no `key` and nothing to validate, so they are
 * skipped exhaustively. Unknown keys are stripped (not rejected), so the same
 * schema can validate a whole config that also carries keys the form doesn't
 * manage.
 */
export function zodFromConfigBlocks(
  blocks: readonly ConfigBlock[],
): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const block of blocks) {
    switch (block.kind) {
      case 'text':
      case 'slug':
      case 'select':
        shape[block.key] = zodForValueBlock(block);
        break;
      case 'section':
      case 'action':
        // No `key`, nothing to validate.
        break;
      default:
        neverAsAny(block);
    }
  }
  return z.object(shape);
}
