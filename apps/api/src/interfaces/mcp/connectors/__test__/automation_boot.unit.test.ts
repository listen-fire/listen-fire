// Boot-time guard: `createMcpRouter` validates every tool's title (<=64
// chars, no internal vocabulary) and safety annotation eagerly, at router
// construction. This pins that the automation connector — including the
// authoring-loop editing primitives (readAutomation/editAutomation/
// grepAutomations) — still passes that check after a tool edit.

import { createAutomationMcpRouter } from '../automation';

describe('automation MCP connector', () => {
  it('builds without throwing (every tool passes the friendly-tool guard)', () => {
    expect(() => createAutomationMcpRouter()).not.toThrow();
  });
});
