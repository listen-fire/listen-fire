// The plan the Rust checker answers for a `listen to <traversal>` is what
// `listenPlanSchema` reads: the wire, end to end through the wasm.
import { callCheckAnswer } from 'movement-lang/wasm/loader';

import { listenPlanSchema, planArrivalSchema, verdictSchema } from '../listen_plan';

const CATALOG = {
  adapters: {
    chat: {
      canFire: false,
      constructionArgs: [],
      schemas: {
        '': {
          positions: {
            Channel: {
              properties: { Name: 'text' },
              edges: { Messages: { target: 'Message', listenable: true, delivery: 'connection', carries: ['Channels'], capability: { filter: 'native', supportsLimit: false } } },
            },
            Message: {
              properties: { Topic: 'text' },
              edges: { Interactions: { target: 'Interaction', readable: false, listenable: true, delivery: 'connection', carries: ['Channels', 'Messages'] } },
              propertyCapabilities: { Topic: { filterOperators: ['eq'] } },
            },
            Interaction: { properties: { Id: 'text', Value: 'text' }, edges: {} },
          },
          collections: { Channels: { target: 'Channel' } },
          writableRoots: {},
        },
      },
    },
  },
  credentials: {},
  plugins: {},
};

const SOURCE = [
  'import { chat as chat_module } from adapters; chat = connect chat_module',
  'function tally(i: <chat-[:Interaction]->>) { return i.Id }',
  'listen as "Lunch" to chat-[:Channels]->-[m:Messages WHERE m.Topic == "lunch-poll"]->-[i:Interactions WHERE i.Value != "skip"]-> fire tally',
  '',
].join('\n');

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function answerOf(source: string): Record<string, unknown> {
  const reply = callCheckAnswer(source, JSON.stringify(CATALOG), {});
  if (!reply.ok || !isRecord(reply.json)) throw new Error(`no check answer: ${JSON.stringify(reply.json)}`);
  return reply.json;
}

describe('a listen plan on the check answer', () => {
  it('reads as the schema says, hop by hop', () => {
    const answer = answerOf(SOURCE);
    expect(answer.diagnostics).toEqual([]);
    const [plan, ...others] = listenPlanSchema.array().parse(answer.listens);
    expect(others).toEqual([]);
    expect(plan).toMatchObject({ movement: 'tally', alias: 'Lunch', connection: 'chat', adapter: 'chat', carries: ['Channels', 'Messages'] });
    expect(plan?.hops.map((h) => [h.edge, h.from, h.to, h.judged])).toEqual([
      ['Channels', '', 'Channel', 'none'],
      ['Messages', 'Channel', 'Message', 'arrival'],
      ['Interactions', 'Message', 'Interaction', 'arrival'],
    ]);
    expect(plan?.hops[1]?.taken).toMatchObject({ type: 'compare', op: 'eq' });
    expect(plan?.hops[2]?.checked).toMatchObject({ type: 'compare', op: 'neq' });
  });

  it('is one plan per member of a union a hop lands on, each naming the union', () => {
    const catalog = {
      adapters: {
        crm: {
          canFire: false,
          constructionArgs: [],
          schemas: {
            '': {
              positions: {
                Person: { properties: { Name: 'text' }, edges: { Notes: { target: 'Note', listenable: true, delivery: 'connection', carries: ['Subjects'] } } },
                Company: { properties: { Name: 'text' }, edges: { Notes: { target: 'Note', listenable: true, delivery: 'connection', carries: ['Subjects'] } } },
                Note: { properties: { Text: 'text' }, edges: {} },
              },
              unions: { Subject: ['Person', 'Company'] },
              collections: { Subjects: { target: 'Subject' } },
              writableRoots: {},
            },
          },
        },
      },
      credentials: {},
      plugins: {},
    };
    const source = 'import { crm as m } from adapters; crm = connect m\nfunction f(n: <crm-[:Note]->>) { return n.Text }\nlisten to crm-[:Subjects]->-[:Notes]-> fire f\n';
    const reply = callCheckAnswer(source, JSON.stringify(catalog), {});
    if (!reply.ok || !isRecord(reply.json)) throw new Error(`no check answer: ${JSON.stringify(reply.json)}`);
    expect(reply.json.diagnostics).toEqual([]);
    const plans = listenPlanSchema.array().parse(reply.json.listens);
    expect(plans.map((plan) => plan.hops.map((h) => [h.edge, h.from, h.to, h.memberOf]))).toEqual([
      [
        ['Subjects', '', 'Person', 'Subject'],
        ['Notes', 'Person', 'Note', undefined],
      ],
      [
        ['Subjects', '', 'Company', 'Subject'],
        ['Notes', 'Company', 'Note', undefined],
      ],
    ]);
  });

  it('is absent from an answer with no listen on a traversal', () => {
    expect(answerOf('import { chat as chat_module } from adapters; chat = connect chat_module\n')).not.toHaveProperty('listens');
  });

  it('refuses a plan with a member it does not know', () => {
    const plan = { movement: 'f', connection: 'c', adapter: 'a', hops: [{ edge: 'E', from: '', to: 'T', judged: 'arrival', extra: 1 }] };
    expect(listenPlanSchema.safeParse(plan).success).toBe(false);
    expect(listenPlanSchema.safeParse({ ...plan, hops: [{ edge: 'E', from: '', to: 'T', judged: 'sometimes' }] }).success).toBe(false);
  });
});

describe('what the listen judge reads and answers', () => {
  it('keeps a hop alias read, a WITHIN and the owned fields a plan carries', () => {
    const hop = {
      edge: 'Messages',
      from: '',
      to: 'Message',
      judged: 'arrival',
      owned: ['Query'],
      taken: { type: 'compare', op: 'eq', left: { type: 'edge_property', propertyTypeId: 'Query', fieldOnly: true }, right: { type: 'static', value: 'from:acme' } },
      checked: { type: 'compare', op: 'within', left: { type: 'edge_property', propertyTypeId: 'At', fieldOnly: true }, right: { type: 'static', value: '3d' } },
    };
    const plan = { movement: 'f', connection: 'mail', adapter: 'gmail', hops: [hop] };
    expect(listenPlanSchema.parse(plan)).toEqual(plan);
  });

  it('reads an arrival, each record with the record type it states, its parents null where it carries none, and refuses a member it does not know', () => {
    const arrival = {
      edge: 'Interactions',
      key: 't1',
      landing: { recordType: 'Interaction', fields: { Id: 't1' } },
      parents: [{ recordType: 'Channel', fields: { Name: 'office' } }, null, { fields: { Topic: 'lunch-poll' } }],
      takenApplied: true,
    };
    expect(planArrivalSchema.parse(arrival)).toEqual(arrival);
    expect(planArrivalSchema.safeParse({ ...arrival, filtered: true }).success).toBe(false);
    expect(planArrivalSchema.safeParse({ ...arrival, landing: { Id: 't1' } }).success).toBe(false);
    expect(planArrivalSchema.safeParse({ ...arrival, landing: { ...arrival.landing, recordId: 't1' } }).success).toBe(false);
  });

  it('answers exactly one of fires, skips and undecided', () => {
    for (const verdict of [{ fires: true }, { skips: 2 }, { undecided: 'the arrival carries no Messages record' }]) {
      expect(verdictSchema.parse(verdict)).toEqual(verdict);
    }
    for (const verdict of [{ fires: false }, { skips: -1 }, { skips: 1.5 }, { fires: true, skips: 0 }, {}]) {
      expect(verdictSchema.safeParse(verdict).success).toBe(false);
    }
  });
});
