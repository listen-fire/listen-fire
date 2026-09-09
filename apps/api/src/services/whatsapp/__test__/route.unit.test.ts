// The inbound gate: which code path a receiving number is allowed to take.
// Once a movements number is configured, the two numbers HARD-partition —
// the movements number reaches movements only, the primary number reaches the
// legacy pipeline only, neither can cross into the other. Before a movements
// number is configured (the dev loop, prod pre-cutover) the single primary
// number keeps its original movement-first-then-legacy behaviour.

import { resolveWhatsappRoute } from '../route';

describe('resolveWhatsappRoute', () => {
  const MOVE = 'PN_MOVE';
  const PRIMARY = 'PN_PRIMARY';

  describe('movements number configured', () => {
    it('event on the movements number → movement-only', () => {
      expect(
        resolveWhatsappRoute({ businessPhoneNumberId: MOVE, movementsPhoneNumberId: MOVE }),
      ).toBe('movement-only');
    });

    it('event on the primary number → legacy-only', () => {
      expect(
        resolveWhatsappRoute({ businessPhoneNumberId: PRIMARY, movementsPhoneNumberId: MOVE }),
      ).toBe('legacy-only');
    });

    it('event with no receiving number (old position / bare primary door) → legacy-only', () => {
      expect(
        resolveWhatsappRoute({ businessPhoneNumberId: undefined, movementsPhoneNumberId: MOVE }),
      ).toBe('legacy-only');
    });
  });

  describe('no movements number configured', () => {
    it('falls back to the original behaviour regardless of receiving number', () => {
      expect(
        resolveWhatsappRoute({ businessPhoneNumberId: PRIMARY, movementsPhoneNumberId: null }),
      ).toBe('movement-then-legacy');
      expect(
        resolveWhatsappRoute({ businessPhoneNumberId: undefined, movementsPhoneNumberId: null }),
      ).toBe('movement-then-legacy');
    });
  });
});
