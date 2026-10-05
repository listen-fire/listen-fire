import { ACME_INTRO_TEXT, type Task } from '../task';

/**
 * Deliberately ambiguous: "let the team know" names no place. The obvious
 * guess (#dealflow) is the wrong one, so only a builder that asks gets it right.
 */
export const ambiguousChannel: Task = {
  id: 'ambiguous-channel',
  title: 'Ambiguous: "let the team know" — where?',
  source: 'ambiguous request (clarifying question expected)',
  request: 'Let the team know whenever a new startup intro comes into the deals inbox.',
  hiddenSpec:
    "Post it in #portfolio: that's where the partners actually look; #dealflow is too noisy. Just the company's name and one line on what they do.",
  clarificationExpected: 'where (which channel) the team should be told',
  connections: ['slack'],
  fixtures: [
    {
      id: 'acme-intro',
      description: 'one post in #portfolio, none in #dealflow',
      event: { kind: 'email', subject: 'Fwd: Acme AI — Series A intro', text: ACME_INTRO_TEXT },
      assertions: [
        { kind: 'created', collection: 'slack/messages', where: { channel: 'portfolio', text: /acme/i }, count: 1 },
        { kind: 'created', collection: 'slack/messages', where: { channel: 'dealflow' }, count: 0 },
      ],
    },
  ],
};

/**
 * Deliberately ambiguous: "the people in it" could be the sender or the people
 * the email talks about. The sender is the user's colleague who forwarded it.
 */
export const ambiguousPeople: Task = {
  id: 'ambiguous-people',
  title: 'Ambiguous: "add the people in it" — which people?',
  source: 'ambiguous request (clarifying question expected)',
  request: 'When an intro email comes in, add the people in it to Attio.',
  hiddenSpec:
    "I mean the founders the intro is about, not whoever sent or forwarded it to us (that's usually a colleague of mine). Their names, and their email address when it's given.",
  clarificationExpected: 'which people: the founders named in the email, or its sender',
  connections: ['attio'],
  fixtures: [
    {
      id: 'acme-intro',
      description: 'both founders, not the forwarding colleague',
      event: { kind: 'email', subject: 'Fwd: Acme AI — Series A intro', text: ACME_INTRO_TEXT },
      assertions: [
        { kind: 'created', collection: 'attio/people', where: { name: /alice/i }, count: 1 },
        { kind: 'created', collection: 'attio/people', where: { name: /bob/i }, count: 1 },
        { kind: 'created', collection: 'attio/people', where: { name: /dev loop/i }, count: 0 },
        { kind: 'present', collection: 'attio/people', where: { email_addresses: 'alice@acme.ai' }, count: 1 },
      ],
      mayAlsoTouch: ['attio/companies'],
    },
  ],
};
