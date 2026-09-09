/**
 * F1 acceptance gate — orchestrator forwards `funnel_context` from the
 * conversation row into the active agent's `AgentInvocation`.
 *
 * What this covers:
 *
 *   1. When a `agent_conversation` row carries a non-null `funnelContext`
 *      jsonb, the orchestrator hands it to the agent runner via
 *      `AgentInvocation.funnelContext`.
 *   2. When `funnelContext` is null on the row, the invocation receives
 *      `null` — no fabrication, no default.
 *   3. The exact shape (leafSlug, pain, painShape, domain, primer,
 *      suggestedArc, templateRef) survives the round-trip unchanged.
 *
 * Together with F2's prompt tests (which assert the system prompt picks
 * up the funnel context block when invocation.funnelContext is present),
 * these tests close the F1 → F2 seam.
 *
 * Pattern: mocks Prisma (no DB), mocks the message queue, overrides the
 * `unified`-domain agent with a fake that captures the invocation it
 * receives. Drives `runConversationTurn` and asserts on the captured
 * invocation.
 *
 */

// ---------------------------------------------------------------------------
// Hoisted mocks — must precede any import that pulls in the orchestrator.
// ---------------------------------------------------------------------------

// Capture the conversation rows the orchestrator reads + the messages
// it tries to write, plus the active session id. The fake prisma below
// reads from `mockConversationsById` so each test seeds the row it
// expects under a stable id.
const mockConversationsById = new Map<string, any>();
const mockMessages: any[] = [];

jest.mock('../../message_queue', () => ({
  mq: {
    agentUpdates: {
      // `on`/`off` cover the editor-action deriver the orchestrator
      // attaches per turn (V2 activity layer).
      update: { publish: jest.fn(), on: jest.fn(), off: jest.fn() },
    },
  },
}));

// N1 — orchestrator now snapshots `navigation_state` per turn via the
// NavigationState service (kysely-backed). These tests run without a
// real DB, so stub the service to return an empty navigation; the
// invocation captures it but the F1 seam doesn't care about its
// contents.
jest.mock('../../../services/navigation_state', () => ({
  getNavigation: jest.fn(async () => ({})),
}));

// Minimal prisma stub — only the methods runConversationTurn reaches
// for on the happy path. Hand-back / handoff / failure branches are
// covered elsewhere; F1's seam is the happy-path passthrough.
const mockActingTeamId = 'team-f1';

jest.mock('../../../services/context', () => ({
  currentContext: () => ({
    // The orchestrator reads the conversation AS the acting team (phase 6.2),
    // so the stub answers a `teamId` and the finder below honours it — a turn
    // dispatched against another team's conversation finds nothing.
    user: { teamId: mockActingTeamId, id: 'user-f1' },
    prisma: {
      agentConversation: {
        findFirstOrThrow: jest.fn(
          async ({ where }: { where: { id: string; teamId: string } }) => {
            const row = mockConversationsById.get(where.id);
            if (!row || row.teamId !== where.teamId) {
              throw new Error(`No mock conversation for ${where.id}`);
            }
            return row;
          },
        ),
        update: jest.fn(async () => undefined),
      },
      agentMessage: {
        create: jest.fn(async ({ data }: { data: any }) => {
          const id = `msg-${mockMessages.length}`;
          const row = { id, ...data };
          mockMessages.push(row);
          return row;
        }),
        update: jest.fn(async () => undefined),
        delete: jest.fn(async () => undefined),
      },
    },
  }),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import { runConversationTurn } from '../orchestrator';
import {
  registerAgent,
  initAgentRegistry,
  type AgentInvocation,
  type AgentInvocationFunnelContext,
} from '../agent_registry';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const CAPTURED: AgentInvocation[] = [];

beforeAll(async () => {
  // Initialise the real registry, then OVERRIDE the unified runner with
  // a capture-only stand-in. `registerAgent` updates the registry in
  // place; the subsequent run of runConversationTurn picks up the
  // override.
  await initAgentRegistry();
  registerAgent({
    domain: 'unified',
    canHandoffTo: [],
    run: async (invocation) => {
      CAPTURED.push(invocation);
      return {
        text: 'ack',
        trace: [],
        suggestedActions: [],
        attachments: [],
      };
    },
  });
});

beforeEach(() => {
  CAPTURED.length = 0;
  mockConversationsById.clear();
  mockMessages.length = 0;
});

function seedConversation({
  id,
  funnelContext,
}: {
  id: string;
  funnelContext: AgentInvocationFunnelContext | null;
}) {
  mockConversationsById.set(id, {
    id,
    teamId: 'team-f1',
    userId: 'user-f1',
    agentType: 'knowledge_query',
    activeAgent: 'unified',
    handoffDepth: 0,
    title: 'F1 plumbing test',
    funnelContext,
    agentMessages: [],
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('orchestrator — funnel context passthrough (F1)', () => {
  it('forwards a populated funnel context unchanged to the active agent', async () => {
    const funnelContext: AgentInvocationFunnelContext = {
      leafSlug: 'pain.move.email-to-crm.dealflow',
      pain: 'I waste hours moving information between tools',
      painShape: 'Pulling things from email and chat into a CRM or database',
      domain: 'Dealflow',
      primer:
        'The user spends hours copying dealflow signals out of email and chat into a CRM.',
      suggestedArc: 'integration-first',
      templateRef: 'vc-dealflow',
    };

    seedConversation({ id: 'conv-1', funnelContext });

    await runConversationTurn({
      conversationId: 'conv-1',
      userMessage: '',
      sessionId: 's-1',
    });

    expect(CAPTURED).toHaveLength(1);
    expect(CAPTURED[0].funnelContext).toEqual(funnelContext);
  });

  it('forwards null when the conversation has no funnel context', async () => {
    seedConversation({ id: 'conv-2', funnelContext: null });

    await runConversationTurn({
      conversationId: 'conv-2',
      userMessage: '',
      sessionId: 's-2',
    });

    expect(CAPTURED).toHaveLength(1);
    expect(CAPTURED[0].funnelContext).toBeNull();
  });

  it('survives a model-first leaf with no templateRef', async () => {
    // Many model-first leaves carry no template hint until F5 lands.
    // The orchestrator must round-trip that absence faithfully.
    const funnelContext: AgentInvocationFunnelContext = {
      leafSlug: 'pain.find.relational.people-companies',
      pain: "I can't find what I knew even though it's somewhere",
      painShape: 'I want to ask questions like "every X who did Y" but can\'t',
      domain: 'People and companies',
      primer:
        'The user wants to ask relational questions about people and companies.',
      suggestedArc: 'model-first',
    };

    seedConversation({ id: 'conv-3', funnelContext });

    await runConversationTurn({
      conversationId: 'conv-3',
      userMessage: '',
      sessionId: 's-3',
    });

    expect(CAPTURED).toHaveLength(1);
    expect(CAPTURED[0].funnelContext).toEqual(funnelContext);
    expect(CAPTURED[0].funnelContext?.templateRef).toBeUndefined();
  });
});
