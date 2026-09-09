// One MCP connector per product, mounted only where its product runs.
//
// The connectors used to be ~700 lines of tool definitions inline in
// server.ts; they are the same definitions, moved so that "which connectors
// does this deployment serve?" is one legible answer rather than a scroll.

import type { Express } from 'express';

import { mounts } from '../../../products';
import { AUTOMATION_MCP_PATH, createAutomationMcpRouter } from './automation';
import { KNOWLEDGE_MCP_PATH, createKnowledgeMcpRouter } from './knowledge';
import { VALUATIONS_MCP_PATH, createValuationsMcpRouter } from './valuations';

function mountMcpConnectors(app: Express) {
  if (mounts('valuations')) app.use(VALUATIONS_MCP_PATH, createValuationsMcpRouter());
  if (mounts('automations')) app.use(AUTOMATION_MCP_PATH, createAutomationMcpRouter());
  if (mounts('knowledge')) app.use(KNOWLEDGE_MCP_PATH, createKnowledgeMcpRouter());
}

export { mountMcpConnectors };
