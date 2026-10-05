import { ACME_INTRO_TEXT, attioCompany, type Task } from '../task';

/** use_cases dealflow-extraction + patterns#extract-and-connect: companies with their founders attached. */
export const dealflowExtraction: Task = {
  id: 'dealflow-extraction',
  title: 'Intro email → Attio company with its founders',
  source: 'use_cases#dealflow-extraction, patterns#extract-and-connect, __fixtures__ dealflow email',
  request: 'Can you log the startups from forwarded intro emails into Attio, along with their founders?',
  hiddenSpec:
    "For each forwarded intro, add the startup to Attio as a company (name and website) and each founder as a person with their full name and job title, on that company's team. Skip whoever forwarded the email: that's my colleague, not a founder. Never create a company twice; if it's already in Attio, add the founders to the existing one. If an email isn't about any startup (a newsletter, say), nothing should be added.",
  connections: ['attio'],
  fixtures: [
    {
      id: 'acme-intro',
      description: 'the company and both founders, nobody else',
      event: { kind: 'email', subject: 'Fwd: Acme AI — Series A intro', text: ACME_INTRO_TEXT },
      assertions: [
        { kind: 'created', collection: 'attio/companies', where: { name: /acme/i }, count: 1 },
        { kind: 'created', collection: 'attio/companies', count: 1, label: 'no other company created' },
        { kind: 'created', collection: 'attio/people', where: { name: /alice/i }, count: 1 },
        { kind: 'created', collection: 'attio/people', where: { name: /bob/i }, count: 1 },
        { kind: 'created', collection: 'attio/people', count: 2, label: 'only the two founders' },
      ],
    },
    {
      id: 'duplicate-company',
      description: 'a company already in Attio is reused, its founder still added',
      seed: [attioCompany({ id: 'company-bramble', name: 'Bramble Health', domain: 'bramble.health' })],
      event: {
        kind: 'email',
        subject: 'Fwd: Bramble Health intro',
        text: `Hey team,\n\nForwarding an intro to Bramble Health (https://bramble.health), remote physio for knee injuries. Founder is Carla Diaz (CEO, ex-NHS).\n\n— A\n\n---------- Forwarded message ----------\nFrom: Carla Diaz <carla@bramble.health>\nSubject: Bramble Health — pre-seed\n\nHi, we're raising a $1.5M pre-seed. Happy to chat.\n\nCarla`,
      },
      assertions: [
        { kind: 'created', collection: 'attio/companies', count: 0, label: 'no duplicate company' },
        { kind: 'present', collection: 'attio/companies', where: { name: /bramble/i }, count: 1 },
        { kind: 'created', collection: 'attio/people', where: { name: /carla/i }, count: 1 },
      ],
    },
    {
      id: 'nothing-found',
      description: 'a newsletter with no startup in it adds nothing',
      event: {
        kind: 'email',
        subject: 'Fwd: This week in climate',
        text: `FYI — the weekly newsletter.\n\nThis week: carbon prices fell 4%, three panels on grid storage, and a long read on heat pumps. No company announcements this week.\n\n— A`,
      },
      assertions: [
        { kind: 'untouched', collection: 'attio/companies' },
        { kind: 'untouched', collection: 'attio/people' },
      ],
    },
  ],
};
