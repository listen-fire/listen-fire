// The prose contract every chapter is held to — hand-written, or contributed
// by an adapter's manifest. ONE implementation, so a rule can never apply to
// the chapters someone remembered to list and quietly skip the generated ones;
// and callable, so a section that breaks the contract can be shown to be
// caught rather than assumed to be.

import type { Chapter } from '../types';

/** Names of the authoring affordances — mechanics of one consumer's loop, so
 *  never in prose two consumers read. */
const AUTHORING_TOOL_NAMES = [
  'readHandbook',
  'listConnections',
  'describeConnection',
  'connectSystem',
  'grantAccess',
  'validateAutomation',
  'saveAutomation',
  'listAutomations',
  'getAutomation',
  'runAutomation',
  'checkRun',
  'listReviews',
  'submitReview',
];

/** Retired constructs from earlier syntax rounds — none may be taught. */
const RETIRED_SURFACE: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /EXTRACT_VALUE/, label: 'EXTRACT_VALUE' },
  { pattern: /#extract/, label: '#extract' },
  { pattern: /\bfor each\b/, label: 'for each' },
];

const VC_TUNING =
  /\b(founders?|investors?|dealflow|deal ?flow|pre-seed|seed round|funding round|series [abc]\b|term sheets?|cap tables?|portfolio compan|fundrais|venture capital)\b/i;

const INTERNAL_JARGON: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTG\b/, label: 'TG' },
  { pattern: /\bKG\b/, label: 'KG' },
  { pattern: /schemaRef/, label: 'schemaRef' },
];

/** Prose with code fences and inline code removed — the vocabulary rules are
 *  about what the sentences say, not about the identifiers they quote. */
function proseOnly(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
}

/**
 * Every way `chapter` breaks the contract, named. Empty means it holds.
 */
export function proseViolations(chapter: Chapter): string[] {
  const violations: string[] = [];
  const body = `${chapter.title}\n${chapter.content}`;

  for (const { pattern, label } of RETIRED_SURFACE) {
    if (pattern.test(chapter.content)) violations.push(`teaches the retired \`${label}\``);
  }
  for (const tool of AUTHORING_TOOL_NAMES) {
    if (chapter.content.includes(tool)) violations.push(`leaks the tool name \`${tool}\``);
  }
  for (const { pattern, label } of INTERNAL_JARGON) {
    if (pattern.test(chapter.content)) violations.push(`uses the internal shorthand \`${label}\``);
  }
  // The use-cases chapter is, by design, a per-use-case playbook; the dealflow
  // playbook is dealflow-specific on purpose. Every other chapter — a system's
  // section included — must stay use-case-neutral.
  if (chapter.id !== 'use-cases') {
    const vc = VC_TUNING.exec(chapter.content);
    if (vc) violations.push(`is tuned to one use case: "${vc[0]}"`);
  }
  if (((chapter.content.match(/```/g) ?? []).length % 2) !== 0) {
    violations.push('leaves a code fence unclosed');
  }
  const prose = proseOnly(body);
  if (/\bmovements?\b/i.test(prose)) violations.push('says "movement" outside code');
  if (/\basks?\b/i.test(prose)) violations.push('says "ask" outside code');

  return violations;
}
