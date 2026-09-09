import { MQ } from '../native';
import type { AgentUpdate } from '../../openai/types';

export type { AgentUpdate };

const agentUpdatesExchange = new MQ<AgentUpdate>().setPresets({
  update: {
    name: 'agent.update',
    type: 'fanout',
  },
  bySessionId: {
    name: 'agent.update.sessionId',
    type: 'direct',
    key: 'sessionId',
    keyPrefix: 'agent.update.sessionId.',
  },
});

const { update, bySessionId } = agentUpdatesExchange;

bySessionId.attachTo(update);

export { agentUpdatesExchange };
