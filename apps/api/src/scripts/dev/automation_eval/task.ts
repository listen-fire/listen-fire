// What an authoring eval task is: a request a non-technical user would type, the
// hidden spec a simulated user answers from, the world it starts in, the events
// fired at whatever the builder saved, and the end state each event must leave.
//
// End state is read from the fake channels as COLLECTIONS of rows
// ("attio/companies", "slack/messages", "email/sent") — see end_state.ts.

/**
 * How one field of a row is matched. A string matches case-insensitively,
 * ignoring surrounding whitespace, against any of the field's values; a RegExp
 * is tested against each value; `present` asks only whether the field has a
 * non-empty value.
 */
type Matcher = string | RegExp | { present: boolean };

/** Exactly n, or a range. */
type Count = number | { min?: number; max?: number };

/**
 * What one fixture must leave behind, judged on the change it caused (the rows
 * it created or updated) or on the whole collection after it.
 */
type Assertion =
  | { kind: 'created'; collection: string; where?: Record<string, Matcher>; count: Count; label?: string }
  | { kind: 'updated'; collection: string; where?: Record<string, Matcher>; count: Count; label?: string }
  | { kind: 'present'; collection: string; where?: Record<string, Matcher>; count: Count; label?: string }
  | { kind: 'untouched'; collection: string; label?: string };

/** An inbound email, delivered to every inbound address the builder's automations listen on. */
interface EmailEvent {
  kind: 'email';
  subject: string;
  text: string;
  /** Defaults to the dev-loop user, which is what routes the mail to the eval team. */
  from?: string;
  attachments?: Array<{ filename: string; contentType: string; content: string }>;
}

/** A schedule tick, fired immediately at every scheduled listener. */
interface ScheduleEvent {
  kind: 'schedule';
}

/** An on-demand run of the automation the builder saved, with pasted text. */
interface ManualEvent {
  kind: 'manual';
  text: string;
}

type FixtureEvent = EmailEvent | ScheduleEvent | ManualEvent;

/** How the harness, standing in for the user, answers an approval a run asks for. */
type ReviewAnswer = 'approve' | 'reject';

interface Fixture {
  id: string;
  /** What this case probes, in one line (shows in the summary). */
  description: string;
  event: FixtureEvent;
  /** Defaults to approve. */
  review?: ReviewAnswer;
  /** Rows added to the fake channels just before the event fires. */
  seed?: SeedRows[];
  assertions: Assertion[];
  /**
   * Collections this event may change beyond the ones its assertions name.
   * Any other collection that changes fails the fixture ("nothing else touched").
   */
  mayAlsoTouch?: string[];
}

/** Rows written straight into a fake service's store (admin seed endpoint). */
interface SeedRows {
  service: string;
  entities: Array<{ entity_type: string; id?: string; data: Record<string, unknown> }>;
}

interface Task {
  id: string;
  title: string;
  /** Handbook pattern or source this task was seeded from. */
  source: string;
  /** Exactly what the user types first, in business terms. */
  request: string;
  /**
   * What the user actually wants, in their words. The simulated user answers the
   * builder's questions from this and never reveals more than it is asked.
   */
  hiddenSpec: string;
  /** Systems (listConnections ids) the task needs connected before building. */
  connections: string[];
  /** Rows present before the builder starts. */
  seed?: SeedRows[];
  /**
   * Set on a deliberately ambiguous request: the decision a good builder asks
   * about before building, rather than guessing.
   */
  clarificationExpected?: string;
  /** A send to someone outside the team happens on the happy path: it needs an approval step. */
  sendsToThirdParty?: boolean;
  fixtures: Fixture[];
}

/** The forwarded Acme intro the dev-loop fixtures are built around. */
const ACME_INTRO_TEXT = `Hey team,

Forwarding the intro below — Acme AI is raising a $5M Series A led by Sequoia, with Greylock participating. Founders are Alice Chen (CEO, ex-OpenAI) and Bob Okafor (CTO, ex-Anthropic).

Worth a closer look.

— A

---------- Forwarded message ----------
From: Alice Chen <alice@acme.ai>
Subject: Acme AI Series A — quick intro

Hi,

We're closing a $5M Series A next month. Sequoia is leading; Greylock is in. Website: https://acme.ai

Best,
Alice & Bob`;

/** An Attio company row in the fake's stored shape, for seeding. */
function attioCompany(input: { id: string; name: string; domain?: string; description?: string }): SeedRows {
  const values: Record<string, unknown[]> = { name: [{ value: input.name }] };
  if (input.domain) values.domains = [{ domain: input.domain }];
  if (input.description) values.description = [{ value: input.description }];
  return {
    service: 'attio',
    entities: [
      {
        entity_type: 'record:companies',
        id: input.id,
        data: { id: { workspace_id: 'test', object_id: 'companies', record_id: input.id }, values },
      },
    ],
  };
}

export { ACME_INTRO_TEXT, attioCompany };
export type {
  Assertion,
  Count,
  EmailEvent,
  Fixture,
  FixtureEvent,
  ManualEvent,
  Matcher,
  ReviewAnswer,
  ScheduleEvent,
  SeedRows,
  Task,
};
