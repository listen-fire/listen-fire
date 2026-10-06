// The dimension a trial varies along, and how the command line names it.
//
//   --variants noskill,skill   whether the builder carries the builder skill
//
// Every variant runs for every task.

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

/** One trial's file name: task, skill variant, repetition. */
function trialFileName(input: { taskId: string; variant: Variant; rep: number }): string {
  return `${input.taskId}.${input.variant}.${input.rep + 1}.json`;
}

export { parseVariants, trialFileName, VARIANTS };
