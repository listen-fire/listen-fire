/**
 * Unit coverage for the trigger display-name helpers. `resolveAutomationName`
 * is the guard against the `movement/<file>/<lane>` dispatch key leaking to
 * the dashboard, control-tower runs, and "your asks" surfaces — the join it
 * prefers, and the parse it falls back to, both need to hold.
 */

import { parseTriggerName, resolveAutomationName } from '../naming';

describe('parseTriggerName', () => {
  it('splits the movement/<file>/<lane> convention', () => {
    expect(parseTriggerName('movement/announce/wait_for_go')).toEqual({
      automation: 'announce',
      lane: 'wait_for_go',
    });
  });

  it('nulls the lane when it equals the file name — nothing to distinguish', () => {
    expect(parseTriggerName('movement/backfill_meetings/backfill_meetings')).toEqual({
      automation: 'backfill_meetings',
      lane: null,
    });
  });

  it('passes through names that do not match the convention', () => {
    expect(parseTriggerName('Weekly digest email')).toEqual({
      automation: 'Weekly digest email',
      lane: null,
    });
    expect(parseTriggerName('movement/only-two-parts')).toEqual({
      automation: 'movement/only-two-parts',
      lane: null,
    });
  });
});

describe('resolveAutomationName', () => {
  it('prefers the joined movement name over the raw trigger name', () => {
    const name = resolveAutomationName(
      { name: 'movement/announce/wait_for_go', movementId: 'm1' },
      new Map([['m1', 'Announce new deals']]),
    );
    expect(name).toBe('Announce new deals');
  });

  it('falls back to the parsed name when the movement id has no match', () => {
    const name = resolveAutomationName(
      { name: 'movement/announce/wait_for_go', movementId: 'm1' },
      new Map(),
    );
    expect(name).toBe('announce');
  });

  it('falls back to the parsed name when there is no movement id at all', () => {
    const name = resolveAutomationName(
      { name: 'movement/announce/wait_for_go', movementId: null },
      new Map(),
    );
    expect(name).toBe('announce');
  });

  it('leaves a non-movement trigger name untouched', () => {
    const name = resolveAutomationName(
      { name: 'Inbound Attio webhook', movementId: null },
      new Map(),
    );
    expect(name).toBe('Inbound Attio webhook');
  });
});
