// The mount path for each MCP connector — spelled once so a connector's own
// router and anything that needs to point at its URL (the public capabilities
// probe, OAuth resource metadata) can never drift out of step.

const AUTOMATION_MCP_PATH = '/api/v1/mcp/automation';
const KNOWLEDGE_MCP_PATH = '/api/v1/mcp/knowledge';
const VALUATIONS_MCP_PATH = '/api/v1/mcp/valuations';

export { AUTOMATION_MCP_PATH, KNOWLEDGE_MCP_PATH, VALUATIONS_MCP_PATH };
