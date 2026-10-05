// What the connector tells an authoring agent about the build loop: start with
// getStarted, save without a separate validate, look things up rather than
// read chapters, and call independent tools together. Pinned because these
// sentences are what turn a 13-call build into a 4-call one.

import { automationConnectorOptions, automationInstructions } from '../automation';

const tools = automationConnectorOptions().tools ?? {};
const description = (name: string) => tools[name]?.description ?? '';

describe('the build loop the connector teaches', () => {
  it.each(['lean', 'examples', 'full'] as const)('points at getStarted first, in the %s handbook', (mode) => {
    const text = automationInstructions(mode);
    expect(text).toContain('Call getStarted first');
    expect(text).toContain('a separate validateAutomation is not needed');
    expect(text).toContain('Make independent tool calls together, in one turn.');
    expect(text).not.toContain('listTeams');
  });

  it.each(['lean', 'examples'] as const)('says in the %s handbook that chapters are not needed', (mode) => {
    expect(automationInstructions(mode)).toContain("The handbook's chapters are not needed");
  });

  it('offers getStarted as the place to start, read-only, behind its own route', () => {
    expect(description('getStarted')).toMatch(/^START HERE/);
    expect(tools.getStarted?.annotations).toEqual({ readOnlyHint: true });
    expect(tools.getStarted?.endpoint).toEqual({ method: 'GET', path: '/v1/automation/get-started' });
    expect(description('readHandbook')).not.toContain('START HERE');
  });

  it('says saving validates first and saves nothing with errors', () => {
    expect(description('saveAutomation')).toContain('It validates first');
    expect(description('saveAutomation')).toContain('NOTHING is saved');
    expect(description('saveAutomation')).not.toContain('Run validateAutomation first');
    expect(description('validateAutomation')).toContain('you need not call this before saving');
    expect(description('validateAutomation')).not.toContain('ALWAYS run this before saveAutomation');
    expect(description('editAutomation')).toContain('an edit with errors is not saved');
  });
});
