// ## NavigationState — unit tests
//
// Covers the pure-function internals (pinsFromState, appendHistory,
// HISTORY_CAP behavior). DB-touching paths (navigateTo, extendNavigation,
// resolveByName, cross-handoff carrying) are covered by the integration
// test next to this file.

import { __test } from '../navigation_state';

const { pinsFromState, appendHistory, NAMED_PIN_KEYS, HISTORY_CAP } = __test;

describe('NavigationState pure helpers', () => {
  describe('pinsFromState', () => {
    it('extracts a trigger pin from `triggerName`', () => {
      const pins = pinsFromState({ triggerName: 'Dealflow intake' });
      expect(pins).toEqual([{ kind: 'trigger', name: 'Dealflow intake' }]);
    });

    it('ignores unknown keys', () => {
      const pins = pinsFromState({ triggerName: 'X', unknownKey: 'Y' });
      expect(pins).toEqual([{ kind: 'trigger', name: 'X' }]);
    });

    it('ignores empty / non-string values', () => {
      const pins = pinsFromState({ triggerName: '', other: 42 as any });
      expect(pins).toEqual([]);
    });

    it('returns empty for an empty state object', () => {
      expect(pinsFromState({})).toEqual([]);
    });
  });

  describe('appendHistory', () => {
    it('returns the existing history unchanged when no new pins', () => {
      const existing = [{ kind: 'trigger' as const, name: 'X', at: '2026-01-01T00:00:00Z' }];
      const result = appendHistory(existing, []);
      expect(result).toBe(existing);
    });

    it('appends one entry per new pin with an ISO timestamp', () => {
      const before = Date.now();
      const result = appendHistory([], [{ kind: 'trigger', name: 'X' }]);
      const after = Date.now();
      expect(result).toHaveLength(1);
      expect(result[0].kind).toBe('trigger');
      expect(result[0].name).toBe('X');
      const ts = Date.parse(result[0].at);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it('trims to HISTORY_CAP, keeping the newest entries', () => {
      // Seed history with HISTORY_CAP entries
      const seed = Array.from({ length: HISTORY_CAP }, (_, i) => ({
        kind: 'trigger' as const,
        name: `t-${i}`,
        at: new Date(2020, 0, 1, 0, 0, i).toISOString(),
      }));
      const result = appendHistory(seed, [{ kind: 'trigger', name: 'newest' }]);

      expect(result).toHaveLength(HISTORY_CAP);
      // The oldest seed entry (t-0) should have been dropped
      expect(result.find((e) => e.name === 't-0')).toBeUndefined();
      // The newest entry should be present
      expect(result[result.length - 1].name).toBe('newest');
    });
  });

  describe('NAMED_PIN_KEYS', () => {
    it('only maps to known ResolutionKinds', () => {
      const validKinds = new Set(['trigger']);
      for (const kind of Object.values(NAMED_PIN_KEYS)) {
        expect(validKinds.has(kind)).toBe(true);
      }
    });
  });
});
