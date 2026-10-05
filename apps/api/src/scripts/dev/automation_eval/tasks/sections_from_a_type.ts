import type { Task } from '../task';

const DEMO_DAY_NOTES = `Demo day notes, batch 14:
- Lumen: budgeting app for students, 40k downloads.
- Gridstack: a Postgres-compatible database for edge devices.
- Pulsewise: remote cardiac monitoring for clinics.
- Cartly: one-tap grocery reordering for families.
Coffee was bad.`;

/** handbook patterns#sections-from-a-type: a recap whose sections come from a fixed set. */
export const sectionsFromAType: Task = {
  id: 'sections-from-a-type',
  title: 'Pasted demo-day notes → thesis recap in #portfolio',
  source: 'patterns#sections-from-a-type',
  request:
    'I want to paste in my notes from a demo day and get a recap in #portfolio, grouped by our three theses: Consumer, Infra and Health.',
  hiddenSpec:
    'I run it myself whenever I paste notes. One message in #portfolio with a section per thesis, always in the order Consumer, Infra, Health, each listing the companies from the notes that fit it. A thesis with no companies still gets its section.',
  connections: ['slack'],
  fixtures: [
    {
      id: 'demo-day',
      description: 'every thesis in order, each company under its thesis',
      event: { kind: 'manual', text: DEMO_DAY_NOTES },
      assertions: [
        {
          kind: 'created',
          collection: 'slack/messages',
          where: { channel: 'portfolio', text: /consumer[\s\S]*infra[\s\S]*health/i },
          count: 1,
          label: 'one #portfolio recap with the theses in order',
        },
        {
          kind: 'created',
          collection: 'slack/messages',
          where: { text: /infra[\s\S]*gridstack[\s\S]*health[\s\S]*pulsewise/i },
          count: 1,
          label: 'Gridstack under Infra, Pulsewise under Health',
        },
        {
          kind: 'created',
          collection: 'slack/messages',
          where: { text: /^(?=[\s\S]*lumen)(?=[\s\S]*cartly)/i },
          count: 1,
          label: 'both consumer companies listed',
        },
        { kind: 'created', collection: 'slack/messages', count: 1, label: 'nothing posted elsewhere' },
      ],
    },
  ],
};
