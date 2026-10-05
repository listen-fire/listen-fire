// Which automations handbook an authoring agent is served — the switch that
// lets them be compared by the authoring eval before one replaces the others.
//
//   full — today's book: the foundations chapter first, then whole chapters.
//   lean — the front page only (where TypeScript habits mislead, the ideas it
//          lacks, the build loop); everything else is looked up through the
//          language search, and a request for a whole chapter is answered
//          with a pointer to it.
//   examples — lean, with its front page replaced by a few annotated programs
//          whose comments carry the rules (examples_page.ts). Show, not tell.
//
// The deployment chooses with AUTOMATION_HANDBOOK (unset: full). Outside
// production a request may choose for itself with the X-Handbook-Mode header,
// which is how the eval runs every mode against one running stack without a
// restart between trials.

export const HANDBOOK_MODES = ['full', 'lean', 'examples'] as const;
export type HandbookMode = (typeof HANDBOOK_MODES)[number];

export const HANDBOOK_MODE_VAR = 'AUTOMATION_HANDBOOK';
/** Lower case, as Node hands request headers over. */
export const HANDBOOK_MODE_HEADER = 'x-handbook-mode';

export function isHandbookMode(value: string): value is HandbookMode {
  return (HANDBOOK_MODES as readonly string[]).includes(value);
}

function parseMode(raw: string, source: string): HandbookMode {
  const value = raw.trim();
  if (isHandbookMode(value)) return value;
  throw new Error(`${source}='${value}' is not a handbook mode. Use ${HANDBOOK_MODES.join(', ')}.`);
}

/** The deployment's mode. An unknown value fails loudly rather than quietly serving full. */
export function handbookModeFromEnv(env: NodeJS.ProcessEnv = process.env): HandbookMode {
  const raw = env[HANDBOOK_MODE_VAR] ?? '';
  return raw.trim() === '' ? 'full' : parseMode(raw, HANDBOOK_MODE_VAR);
}

/**
 * The mode one request is served in: the header where it is honoured (never in
 * production, so no client can change what a real deployment teaches), else
 * the deployment's.
 */
export function handbookModeFor(
  header: string | string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): HandbookMode {
  const value = Array.isArray(header) ? header[0] : header;
  if (value !== undefined && value.trim() !== '' && env.NODE_ENV !== 'production') {
    return parseMode(value, HANDBOOK_MODE_HEADER);
  }
  return handbookModeFromEnv(env);
}
