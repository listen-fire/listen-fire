import { LEXICON } from '../lexicon';

describe('lexicon', () => {
  it('maps TG → Translation; an avoided term is never the user-facing form', () => {
    const tg = LEXICON.find((e) => e.avoid?.includes('TG'));
    expect(tg?.userFacing).toBe('Translation');
    for (const e of LEXICON) for (const a of e.avoid ?? []) expect(e.userFacing).not.toBe(a);
  });

  it('load-bearing tokens carry no avoid list', () => {
    for (const e of LEXICON) if (e.loadBearing) expect(e.avoid ?? []).toHaveLength(0);
  });
});
