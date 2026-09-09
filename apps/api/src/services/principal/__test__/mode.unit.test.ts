// The identity a process runs on is a security posture, not a preference: a
// value nobody recognises must stop the boot rather than quietly pick one.

import { principalMode } from '../mode';

describe('choosing the identity this process runs on', () => {
  it('runs on core unless told otherwise', () => {
    expect(principalMode({})).toBe('core');
    expect(principalMode({ LISTEN_FIRE_PRINCIPAL: '' })).toBe('core');
    expect(principalMode({ LISTEN_FIRE_PRINCIPAL: 'core' })).toBe('core');
  });

  it('runs on the static single-tenant identity when asked', () => {
    expect(principalMode({ LISTEN_FIRE_PRINCIPAL: 'static' })).toBe('static');
  });

  it('refuses to guess at anything else', () => {
    expect(() => principalMode({ LISTEN_FIRE_PRINCIPAL: 'Static' })).toThrow(/must be "core" or "static"/);
    expect(() => principalMode({ LISTEN_FIRE_PRINCIPAL: 'none' })).toThrow(/got "none"/);
  });
});
