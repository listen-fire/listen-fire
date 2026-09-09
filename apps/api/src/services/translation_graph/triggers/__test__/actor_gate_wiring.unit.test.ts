import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('actor gate — router wiring pin', () => {
  const routerSrc = readFileSync(join(__dirname, '../router.ts'), 'utf-8');
  it('the router consults the gate and marks the receipt on a drop', () => {
    expect(routerSrc).toMatch(/consultActorGate/);
    expect(routerSrc).toMatch(/'actor_unregistered'/);
    expect(routerSrc).toMatch(/markTriggerEventSuppressed\(input\.storedEventId, actorGate\.reason\)/);
  });
});
