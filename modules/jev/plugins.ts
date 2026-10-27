// The two plugins: what each declares to the checker, and its body.
//
// Both answer a record rather than a bare value. The engine hands a plain
// call's `value` output back as the text the plugin fetched (a file aside), so
// a number declared as a value would reach the movement as text; a record's
// fields keep their types.

import type { PluginDeclaration } from 'engine-contracts';
import type { PluginAnswer } from 'module-kit';

import { askJev, type JevAnswer, type JevEndpoint } from './client';

const SUBJECT = {
  name: 'subject',
  // Structured data: a text, or a record (read as its fields).
  type: { kind: 'json' },
  required: true,
  description: 'What Jev reads: a text, or a record, read as its fields with the empty ones left out.',
} as const;

export const SCORE_PLUGIN: PluginDeclaration = {
  priced: true,
  signature: {
    name: 'score',
    description:
      'How likely a statement about the subject is true, from 0 to 1, from Jev: a fast, cheap judge that answers with a probability and writes no text.',
    params: [
      SUBJECT,
      {
        name: 'question',
        type: { kind: 'string' },
        required: true,
        description: 'The statement or yes-or-no question to weigh, in plain words ("Is this an inbound fundraising pitch?").',
      },
    ],
    dataDependency: 'none',
    additions: {},
    effects: { ai: true },
    output: {
      kind: 'record',
      fields: { probability: { type: { kind: 'number' }, description: 'How likely the statement is true, from 0 to 1.' } },
    },
  },
};

export const CLASSIFY_PLUGIN: PluginDeclaration = {
  priced: true,
  signature: {
    name: 'classify',
    description:
      'Which of a few labels fits the subject, with how sure Jev is: a fast, cheap judge that picks one label and writes no text.',
    params: [
      SUBJECT,
      {
        name: 'labels',
        type: { kind: 'list', element: { kind: 'string' } },
        required: true,
        description: 'The labels to choose between, at least two; each label describes its option to Jev, so a few plain words beat a code.',
      },
      {
        name: 'question',
        type: { kind: 'string' },
        required: true,
        description: 'What to decide, in plain words ("What kind of inbound email is this?").',
      },
    ],
    dataDependency: 'none',
    additions: {},
    effects: { ai: true },
    output: {
      kind: 'record',
      fields: {
        label: { type: { kind: 'string' }, description: 'The label that fits best: one of the labels given.' },
        confidence: { type: { kind: 'number' }, description: 'How likely that label is right, from 0 to 1.' },
      },
    },
  },
};

export const JEV_PLUGINS: readonly PluginDeclaration[] = [SCORE_PLUGIN, CLASSIFY_PLUGIN];

export interface JevCall {
  endpoint: JevEndpoint;
  fetch: typeof fetch;
  retryDelayMs?: number;
}

/** The one key each request asks its question under. */
const ANSWER = 'answer';

/** A text as itself; a record without its empty fields (the model gains
 *  nothing from being told a field is absent), as the entity judge sends it. */
function stateOf(caller: string, subject: unknown): unknown {
  if (subject === null || subject === undefined || (typeof subject === 'string' && subject.trim() === '')) {
    throw new Error(`${caller} has nothing to read: the subject is empty`);
  }
  if (typeof subject !== 'object' || Array.isArray(subject)) return subject;
  return Object.fromEntries(Object.entries(subject).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function questionOf(caller: string, question: unknown): string {
  if (typeof question !== 'string' || question.trim() === '') throw new Error(`${caller} needs a question: what to decide, in plain words`);
  return question.trim();
}

function labelsOf(labels: unknown): string[] {
  const given = Array.isArray(labels) ? labels : [];
  if (given.length < 2) throw new Error('jev.classify needs at least two labels to choose between');
  const seen = new Set<string>();
  for (const label of given) {
    if (typeof label !== 'string' || label.trim() === '') throw new Error('jev.classify: a label is empty');
    if (seen.has(label)) throw new Error(`jev.classify: the label "${label}" is given twice`);
    seen.add(label);
  }
  return [...seen];
}

function answerOf(caller: string, answers: Record<string, JevAnswer>): JevAnswer {
  const answer = answers[ANSWER];
  if (answer === undefined) throw new Error(`${caller}: Jev answered no question`);
  return answer;
}

export async function score(config: Record<string, unknown>, call: JevCall): Promise<PluginAnswer> {
  const caller = 'jev.score';
  const state = stateOf(caller, config.subject);
  const instructions = questionOf(caller, config.question);
  const reply = await askJev({ state, questions: { [ANSWER]: { type: 'noul', instructions } }, caller }, call);
  const answer = answerOf(caller, reply.answers);
  if (answer.type !== 'noul') throw new Error(`${caller}: Jev answered a ${answer.type}, not a probability`);
  return { data: { probability: answer.noul }, costMicrodollars: reply.costMicrodollars };
}

/**
 * One `choice` question. Each label rides as an option's description under a
 * key of its own (`o0`, `o1`, …), so a label can be any text without being a
 * key Jev has to accept, and the choice maps back to the label exactly.
 */
export async function classify(config: Record<string, unknown>, call: JevCall): Promise<PluginAnswer> {
  const caller = 'jev.classify';
  const state = stateOf(caller, config.subject);
  const labels = labelsOf(config.labels);
  const instructions = questionOf(caller, config.question);
  const criteria = Object.fromEntries(labels.map((label, i) => [`o${i}`, label]));
  const reply = await askJev({ state, questions: { [ANSWER]: { type: 'choice', instructions, criteria } }, caller }, call);
  const answer = answerOf(caller, reply.answers);
  if (answer.type !== 'choice') throw new Error(`${caller}: Jev answered a ${answer.type}, not a choice`);
  const label = criteria[answer.choice];
  if (label === undefined) throw new Error(`${caller}: Jev chose "${answer.choice}", which is none of the labels`);
  return { data: { label, confidence: answer.confidence }, costMicrodollars: reply.costMicrodollars };
}
