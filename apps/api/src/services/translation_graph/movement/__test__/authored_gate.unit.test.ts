// Dispatch liveness gate (storage/authored.ts). Movements are the only
// invoker: a trigger row is purely a movement's `listen` dispatch index
// (no orchestration / object code; execution reads the canonical movement
// text). So a trigger is live iff it is movement-derived —
// `movement_id IS NOT NULL`. Hand-authored / orphaned rows never dispatch.

import { authoredTriggerIds } from '../../storage/authored';

describe('authoredTriggerIds — movement-derivation gate', () => {
  it('a movement-derived trigger is live', () => {
    const live = authoredTriggerIds([{ id: 't-1', movementId: 'm-1' }]);
    expect(live).toEqual(new Set(['t-1']));
  });

  it('a trigger with no movement is not live', () => {
    const live = authoredTriggerIds([{ id: 't-1', movementId: null }]);
    expect(live.size).toBe(0);
  });

  it('a trigger with an undefined movement is not live', () => {
    const live = authoredTriggerIds([{ id: 't-1' }]);
    expect(live.size).toBe(0);
  });

  it('filters a mixed batch to the movement-derived rows', () => {
    const live = authoredTriggerIds([
      { id: 't-hand', movementId: null },
      { id: 't-mov', movementId: 'm-1' },
    ]);
    expect(live).toEqual(new Set(['t-mov']));
  });

  it('an empty batch yields an empty set', () => {
    expect(authoredTriggerIds([]).size).toBe(0);
  });
});
