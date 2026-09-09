// Content-anchored edit: the pure splice half of the Claude-Code-style
// editing primitive over a movement's source text. No persistence, no
// revision/conflict handling and no validity concerns here — the REST route
// (`editAutomation`, interfaces/rest/v1/knowledge_agent_tools.ts) owns
// resolving the row, then hands the result of this function straight to
// `saveMovement`, so an edit is exactly a save with the anchor spliced in.

export type ContentEditOutcome = { ok: true; source: string } | { ok: false; error: string };

/**
 * Replace `oldString` with `newString` in `source`, anchored on content
 * rather than a line number (line numbers go stale after the first edit and
 * the caller has no way to verify them against a program it hasn't re-read).
 *
 * Refuses rather than guessing: zero matches means the caller's anchor
 * doesn't describe the current source, and more than one match without
 * `replaceAll` means the anchor doesn't pin a single location.
 */
export function applyContentEdit(input: {
  source: string;
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}): ContentEditOutcome {
  const { source, oldString, newString, replaceAll = false } = input;
  if (oldString === '') {
    return { ok: false, error: 'oldString must not be empty.' };
  }
  const count = countOccurrences(source, oldString);
  if (count === 0) {
    return {
      ok: false,
      error:
        'oldString was not found in the current source. Read the automation again (readAutomation or getAutomation) and anchor the edit on text that is actually there.',
    };
  }
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      error: `oldString matches ${count} places in the source. Either widen it to a snippet that pins one location, or pass replaceAll: true to change every match.`,
    };
  }
  const spliced = replaceAll ? source.split(oldString).join(newString) : replaceOnce(source, oldString, newString);
  return { ok: true, source: spliced };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count++;
    from = at + needle.length;
  }
}

function replaceOnce(haystack: string, needle: string, replacement: string): string {
  const at = haystack.indexOf(needle);
  return haystack.slice(0, at) + replacement + haystack.slice(at + needle.length);
}
