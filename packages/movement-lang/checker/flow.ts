// Reachability, for the checker's control-flow narrowing.
//
// One question, asked of a statement list: does control ALWAYS leave it by
// failing, rather than falling through to whatever comes next? That is what
// makes the guard clause work —
//
//   if channel == null { ERROR("channel not found") }
//   write channel-[:Messages]-> { … }
//
// — because reaching the write means the `if` was not taken, so the condition's
// NEGATION holds below it (`checkIf` declares that narrowing). TypeScript's own
// analysis, with `ERROR` in the role of `throw`: its type is `never`.
//
// Deliberately shallow. Every construct that is not listed falls through, which
// is the safe answer: a missed terminator costs a narrowing the author could
// have had, while a wrong one would hand out a narrowing that isn't true.

import { Statement } from '../parser/ast';

/**
 * Does every path through `statements` fail before the end of the list?
 *
 * - `ERROR(…)` fails the run (`interpretError` throws), so it terminates.
 * - an `if` terminates only when EVERY arm does AND there is an `else` that
 *   does too — without the else, the no-arm-taken path falls straight through.
 * - anything after a terminator is unreachable, so a terminator ANYWHERE in the
 *   list terminates the list.
 */
export function terminates(statements: Statement[]): boolean {
  return statements.some(terminatesStatement);
}

function terminatesStatement(statement: Statement): boolean {
  if (statement.kind === 'error') return true;
  if (statement.kind === 'if') {
    return (
      statement.elseArm !== undefined
      && terminates(statement.elseArm.body)
      && statement.arms.every(arm => terminates(arm.body))
    );
  }
  return false;
}
