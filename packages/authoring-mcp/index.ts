// The authoring tools as an open source package: an agent writes, checks,
// saves and runs movements over MCP, for one tenant of the host that mounts
// the handler. The host interface is `host.ts`; docs/embedding.md shows a
// host serving it.

export * from './host';
export { createAuthoringHandler, authoringServer, type AuthoringHandler, type AuthoringHandlerOptions } from './server';
export { AUTHORING_TOOL_NAMES, RUN_TOOL_NAMES, authoringInstructions, type AuthoringToolName } from './tools';
export { checkProgram, authoringDiagnostics, type AuthoringDiagnostic, type Validation } from './check';
export { revisionOf, applyContentEdit, readWindow, grepPrograms, GREP_MAX_MATCHES, type ContentEdit, type GrepMatch, type LineWindow } from './text';
export { renderConnectionsDigest, describeFromSnapshot, compactType, DIGEST_LEGEND } from './digest';
export { readHandbook, searchHandbook, HANDBOOK_ID } from './handbook';
