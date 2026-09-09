// The valuations MCP connector, as it was mounted inline in server.ts.
// Moved here so a deployment that does not run valuations does not serve it
// (D30(d)); the definition itself is unchanged.

import { Router } from 'express';

import { createMcpRouter } from '../server';
import { valuationsTools, valuationsInstructions } from '../valuations';
import { VALUATIONS_MCP_PATH } from '../paths';

function createValuationsMcpRouter(): ReturnType<typeof Router> {
  return createMcpRouter({
    name: 'listen-fire-valuations',
    domain: 'valuations',
    // Flat first-class tools alongside the generic call_api/describe_api shim
    // (kept true so existing chats keep working).
    tools: valuationsTools,
    instructions: valuationsInstructions,
  });
}

export { VALUATIONS_MCP_PATH, createValuationsMcpRouter };
