import type { Task } from '../task';

const MEETING_NOTES = `Notes from Tuesday's meetings.

Met Priya Raman (CEO) at Fernway, they make route-planning software for regional courier fleets. Strong team.

Then Tomasz Nowak (CTO) from Hollowbrook, who are building an AI tutor for secondary-school maths.

Follow up with both next month.`;

/** handbook patterns#declare-once: the same record shape extracted and written as declared. */
export const declareOnce: Task = {
  id: 'declare-once',
  title: 'Pasted meeting notes → Attio companies with their people',
  source: 'patterns#declare-once, patterns#extract-and-connect',
  request:
    'Let me paste meeting notes and have every company mentioned saved to Attio with a short description, plus the people we met at each.',
  hiddenSpec:
    "I run it myself when I paste notes. Each company: its name and a one-sentence description of what it does. Each person we met: full name and job title, on their company's team in Attio. Never create a company twice.",
  connections: ['attio'],
  fixtures: [
    {
      id: 'two-meetings',
      description: 'both companies described, each person attached',
      event: { kind: 'manual', text: MEETING_NOTES },
      assertions: [
        {
          kind: 'created',
          collection: 'attio/companies',
          where: { name: /fernway/i, description: { present: true } },
          count: 1,
        },
        {
          kind: 'created',
          collection: 'attio/companies',
          where: { name: /hollowbrook/i, description: { present: true } },
          count: 1,
        },
        { kind: 'created', collection: 'attio/companies', count: 2, label: 'only the two companies' },
        { kind: 'created', collection: 'attio/people', where: { name: /priya/i }, count: 1 },
        { kind: 'created', collection: 'attio/people', where: { name: /tomasz/i }, count: 1 },
        { kind: 'created', collection: 'attio/people', count: 2, label: 'only the two people' },
      ],
    },
  ],
};
