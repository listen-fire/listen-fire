// The dimensions a trial varies along, and how the command line names them.
//
//   --variants noskill,skill   whether the builder carries the builder skill
//   --handbook full,lean   which automations handbook the API serves it
//
// Every combination runs for every task. The handbook needs no restart of the
// stack between trials: the builder asks for its mode on every request to the
// connector (the X-Handbook-Mode header, honoured outside production), so one
// running API serves them all — see lib/knowledge/movement_handbook/handbook_mode.ts.

import { HANDBOOK_MODES, isHandbookMode, type HandbookMode } from '../../../lib/knowledge/movement_handbook/handbook_mode';
import type { Variant } from './builder';

const VARIANTS: readonly Variant[] = ['noskill', 'skill'];

function names(value: string | undefined): string[] | undefined {
  const list = value
    ?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list && list.length > 0 ? list : undefined;
}

/** `--variants`, or `--skill` as shorthand for the skill alone. Default: no skill. */
function parseVariants(input: { variants: string | undefined; skill: boolean }): Variant[] {
  const wanted = input.skill ? ['skill'] : (names(input.variants) ?? ['noskill']);
  return wanted.map((v) => {
    const found = VARIANTS.find((known) => known === v);
    if (!found) throw new Error(`unknown variant "${v}" (expected ${VARIANTS.join(', ')})`);
    return found;
  });
}

/** `--handbook`. Default: the full handbook, which is what a deployment serves today. */
function parseHandbookModes(value: string | undefined): HandbookMode[] {
  return (names(value) ?? ['full']).map((m) => {
    if (!isHandbookMode(m)) throw new Error(`unknown handbook "${m}" (expected ${HANDBOOK_MODES.join(', ')})`);
    return m;
  });
}

/** One trial's file name: task, skill variant, handbook, repetition. */
function trialFileName(input: { taskId: string; variant: Variant; handbook: HandbookMode; rep: number }): string {
  return `${input.taskId}.${input.variant}.${input.handbook}.${input.rep + 1}.json`;
}

export { parseHandbookModes, parseVariants, trialFileName, VARIANTS };
