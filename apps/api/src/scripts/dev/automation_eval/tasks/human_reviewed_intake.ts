import type { Task } from '../task';

const CONFERENCE_LIST = `Startups from SaaStock:
- Orbitly (orbitly.io) — usage-based billing
- Tessel Health (tessel.health) — clinical trial matching
- Kitebase (kitebase.dev) — feature flags for mobile`;

/** handbook patterns#human-reviewed-intake: the approval lives inside the automation. */
export const humanReviewedIntake: Task = {
  id: 'human-reviewed-intake',
  title: 'Pasted list → approval → Attio companies',
  source: 'patterns#human-reviewed-intake',
  request:
    "I'd like to paste in a list of startups from a conference and have them added to Attio, but I want to check the list before anything is saved.",
  hiddenSpec:
    'I run it myself with the pasted text. Before saving, show me the companies it found and ask me to approve. Only if I approve, add each one to Attio as a company with its name and website. If I say no, nothing is saved.',
  connections: ['attio'],
  fixtures: [
    {
      id: 'approved',
      description: 'approving saves all three companies',
      event: { kind: 'manual', text: CONFERENCE_LIST },
      review: 'approve',
      assertions: [
        { kind: 'created', collection: 'attio/companies', where: { name: /orbitly/i }, count: 1 },
        { kind: 'created', collection: 'attio/companies', where: { name: /tessel/i }, count: 1 },
        { kind: 'created', collection: 'attio/companies', where: { name: /kitebase/i }, count: 1 },
        { kind: 'created', collection: 'attio/companies', count: 3, label: 'only the three companies' },
      ],
    },
    {
      id: 'rejected',
      description: 'saying no saves nothing',
      event: {
        kind: 'manual',
        text: 'Startups from WebSummit:\n- Moxa (moxa.ai) — voice notes for sales teams\n- Pebblework (pebblework.com) — kids coding kits',
      },
      review: 'reject',
      assertions: [{ kind: 'untouched', collection: 'attio/companies' }],
    },
  ],
};
