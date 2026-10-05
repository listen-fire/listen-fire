import type { Task } from '../task';

/** handbook patterns#compose-a-report: many small things into one message. */
export const composeAReport: Task = {
  id: 'compose-a-report',
  title: 'Email attachments → one listing in #dealflow',
  source: 'patterns#compose-a-report',
  request: 'Whenever someone emails us files, post a list of the attachment names in #dealflow.',
  hiddenSpec:
    "One message in #dealflow per email, with the email's subject and the name of every attached file. If an email has no attachments, don't post anything at all.",
  connections: ['slack'],
  fixtures: [
    {
      id: 'with-attachments',
      description: 'both file names in one message',
      event: {
        kind: 'email',
        subject: 'Acme AI — data room',
        text: 'Hi, attaching the deck and the financials. — Alice',
        attachments: [
          { filename: 'acme-deck.txt', contentType: 'text/plain', content: 'Acme AI deck. Raising $5M.' },
          { filename: 'acme-financials.csv', contentType: 'text/csv', content: 'year,revenue\n2025,1200000\n' },
        ],
      },
      assertions: [
        {
          kind: 'created',
          collection: 'slack/messages',
          where: { channel: 'dealflow', text: /^(?=[\s\S]*acme-deck)(?=[\s\S]*acme-financials)/i },
          count: 1,
          label: 'one #dealflow message naming both files',
        },
        { kind: 'created', collection: 'slack/messages', count: 1, label: 'nothing posted elsewhere' },
      ],
    },
    {
      id: 'no-attachment',
      description: 'an email with no files posts nothing',
      event: { kind: 'email', subject: 'Quick question', text: 'Are you free Thursday? — Alice' },
      assertions: [{ kind: 'untouched', collection: 'slack/messages' }],
    },
  ],
};
