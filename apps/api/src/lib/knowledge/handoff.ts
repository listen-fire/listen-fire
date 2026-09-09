import type { AgentDomain } from './agent_registry';

// ---------------------------------------------------------------------------
// Handoff signal — thrown by handoff tools to terminate the tool loop
// ---------------------------------------------------------------------------

export class HandoffSignal extends Error {
  readonly isHandoff = true;
  constructor(
    public readonly to: AgentDomain,
    public readonly referral: string,
  ) {
    super(`Handoff to ${to}`);
    this.name = 'HandoffSignal';
  }
}

export class HandBackSignal extends Error {
  readonly isHandBack = true;
  constructor(
    public readonly discharge: string,
  ) {
    super('Hand back to caller');
    this.name = 'HandBackSignal';
  }
}

// ---------------------------------------------------------------------------
// Handoff tool definitions (OpenAI function format, converted by anthropicToolLoop)
// ---------------------------------------------------------------------------

export function buildHandoffToolDefinitions(canHandoffTo: AgentDomain[]) {
  const tools: any[] = [];

  if (canHandoffTo.length > 0) {
    tools.push({
      type: 'function',
      name: 'handoff',
      description:
        'Transfer this conversation to a specialist agent. The handoff is invisible to the user — ' +
        'do NOT produce any user-facing text before calling this tool. Just call it directly.',
      parameters: {
        type: 'object',
        required: ['to', 'referral'],
        properties: {
          to: {
            type: 'string',
            enum: canHandoffTo,
            description: 'The specialist domain to hand off to.',
          },
          referral: {
            type: 'string',
            description:
              "Complete context for the receiving agent. Must include: what the user needs, " +
              "the user's original message/intent, any relevant entity IDs or schema context, " +
              'and references to uploaded files or documents the receiving agent may need to access. ' +
              'The receiving agent has no other context — this is everything it starts with.',
          },
        },
      },
    });
  }

  tools.push({
    type: 'function',
    name: 'hand_back',
    description:
      'Return control to the agent that delegated to you. The hand-back is invisible to the user — ' +
      'do NOT produce any user-facing text before calling this tool. Just call it directly.',
    parameters: {
      type: 'object',
      required: ['discharge'],
      properties: {
        discharge: {
          type: 'string',
          description:
            'Summary of actions taken and relevant outcomes. Include IDs of any created/modified ' +
            'entities, schema changes, or configuration so the returning agent can continue without re-querying.',
        },
      },
    },
  });

  return tools;
}

// ---------------------------------------------------------------------------
// Handoff tool implementations — throw signals caught by the orchestrator
// ---------------------------------------------------------------------------

export function buildHandoffToolImpls() {
  return {
    handoff: async (args: { to: string; referral: string }) => {
      throw new HandoffSignal(args.to as AgentDomain, args.referral);
    },
    hand_back: async (args: { discharge: string }) => {
      throw new HandBackSignal(args.discharge);
    },
  };
}
