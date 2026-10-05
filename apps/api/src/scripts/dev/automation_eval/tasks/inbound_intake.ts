import { ACME_INTRO_TEXT, type Task } from '../task';

/** handbook patterns#inbound-intake + #multi-target: one email, a CRM record and a team post. */
export const inboundIntake: Task = {
  id: 'inbound-intake',
  title: 'Intro email → Attio company + #dealflow post',
  source: 'patterns#inbound-intake, patterns#multi-target, mvt_eval BRIEFS.multi',
  request:
    'When an intro email lands in our deals inbox, add the company to Attio and let the team know in #dealflow.',
  hiddenSpec:
    "Every forwarded intro is about one startup. Add that startup to Attio as a company with its name, its website and a one-line description of what it does. If the company is already in Attio, don't add it again, but still post. The post in #dealflow is one short message naming the company. Nothing else: no people, no deals.",
  connections: ['attio', 'slack'],
  fixtures: [
    {
      id: 'new-company',
      description: 'a first intro creates the company and posts once',
      event: { kind: 'email', subject: 'Fwd: Acme AI — Series A intro', text: ACME_INTRO_TEXT },
      assertions: [
        { kind: 'created', collection: 'attio/companies', where: { name: /acme/i }, count: 1 },
        { kind: 'created', collection: 'attio/companies', count: 1, label: 'no other company created' },
        { kind: 'created', collection: 'slack/messages', where: { channel: 'dealflow', text: /acme/i }, count: 1 },
        { kind: 'created', collection: 'slack/messages', count: 1, label: 'one message, nowhere else' },
      ],
    },
    {
      id: 'repeat-company',
      description: 'a second email about the same company does not duplicate it, and still posts',
      event: {
        kind: 'email',
        subject: 'Fwd: Intro — Acme AI',
        text: `Hi,

Passing along another intro — Acme AI (https://acme.ai) builds AI agents that automate back-office finance work. The founders reached out to me directly and asked to be put in front of your team.

Thought of you.

— Dana

---------- Forwarded message ----------
From: Bob Okafor <bob@acme.ai>
Subject: Intro — Acme AI

Hello,

We're building AI agents for finance teams and are raising our Series A. Would love to talk. Website: https://acme.ai

Best,
Bob`,
      },
      assertions: [
        { kind: 'created', collection: 'attio/companies', count: 0, label: 'no duplicate company' },
        { kind: 'present', collection: 'attio/companies', where: { name: /acme/i }, count: 1 },
        { kind: 'created', collection: 'slack/messages', where: { channel: 'dealflow', text: /acme/i }, count: 1 },
      ],
    },
  ],
};
