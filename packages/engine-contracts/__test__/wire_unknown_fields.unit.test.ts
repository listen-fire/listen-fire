// A field typed `unknown` on the wire is absent whenever its value is
// undefined (JSON drops it), so the schemas must accept the key missing.
import { WirePositionIdentity, WireFilterTranslationResult } from '../index';

describe('wire fields typed unknown', () => {
  it('a position identity with data absent round-trips', () => {
    const identity = { kind: 'unstable' as const };
    const wire = JSON.parse(JSON.stringify({ kind: 'unstable', data: undefined }));
    expect(WirePositionIdentity.parse(wire)).toEqual(identity);
  });

  it('a filter translation with native and residual absent parses', () => {
    expect(WireFilterTranslationResult.parse({})).toEqual({});
  });
});
