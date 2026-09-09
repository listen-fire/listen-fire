// The public document route serves bytes to whoever presents a valid signature,
// so this module IS the authorisation. What's pinned: a link this deployment
// minted verifies, anything else does not, and a TTL — when one is asked for —
// is actually enforced.

const ORIGINAL_ENV = { ...process.env };

import { signDocumentUrl, verifyDocumentSignature } from '../document_link';

const DOC = 'd0cum3nt-0000-0000-0000-000000000001';

function paramsOf(url: string): { sig: string | undefined; exp: string | undefined } {
  const parsed = new URL(url);
  return {
    sig: parsed.searchParams.get('sig') ?? undefined,
    exp: parsed.searchParams.get('exp') ?? undefined,
  };
}

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV };
  process.env.API_BASE_URL = 'https://api.example.com';
  process.env.DOCUMENT_LINK_SECRET = 'test-document-link-secret';
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('signDocumentUrl', () => {
  it('builds the public route on API_BASE_URL and signs it', () => {
    const url = signDocumentUrl(DOC);
    const parsed = new URL(url);

    expect(parsed.origin).toBe('https://api.example.com');
    expect(parsed.pathname).toBe(`/api/public/document/${DOC}/data`);
    expect(parsed.searchParams.get('sig')).toBeTruthy();
  });

  it('carries NO exp by default — a link written into a CRM field must not expire', () => {
    expect(new URL(signDocumentUrl(DOC)).searchParams.has('exp')).toBe(false);
  });

  it('round-trips: what it mints, it verifies', () => {
    expect(verifyDocumentSignature({ documentId: DOC, ...paramsOf(signDocumentUrl(DOC)) })).toBe(
      true,
    );
  });
});

describe('verifyDocumentSignature', () => {
  it('rejects a tampered signature', () => {
    const { sig } = paramsOf(signDocumentUrl(DOC));
    const tampered = `${sig!.slice(0, -1)}${sig!.slice(-1) === 'A' ? 'B' : 'A'}`;

    expect(verifyDocumentSignature({ documentId: DOC, sig: tampered })).toBe(false);
  });

  it('rejects an absent signature — a bare id is not an authorisation', () => {
    expect(verifyDocumentSignature({ documentId: DOC, sig: undefined })).toBe(false);
    expect(verifyDocumentSignature({ documentId: DOC, sig: '' })).toBe(false);
  });

  it("rejects another document's signature (the id is what is signed)", () => {
    const { sig } = paramsOf(signDocumentUrl(DOC));
    expect(verifyDocumentSignature({ documentId: 'some-other-document', sig })).toBe(false);
  });

  it('rejects a signature minted under a different secret', () => {
    const { sig } = paramsOf(signDocumentUrl(DOC));
    process.env.DOCUMENT_LINK_SECRET = 'a-different-secret';

    expect(verifyDocumentSignature({ documentId: DOC, sig })).toBe(false);
  });

  it('accepts a TTL link before its exp', () => {
    const url = signDocumentUrl(DOC, { expiresAt: new Date(Date.now() + 60_000) });
    expect(verifyDocumentSignature({ documentId: DOC, ...paramsOf(url) })).toBe(true);
  });

  it('rejects a TTL link after its exp', () => {
    const url = signDocumentUrl(DOC, { expiresAt: new Date(Date.now() - 1_000) });
    const { sig, exp } = paramsOf(url);

    expect(exp).toBeDefined();
    expect(verifyDocumentSignature({ documentId: DOC, sig, exp })).toBe(false);
  });

  it('rejects a stretched exp — the expiry is inside the signature, not beside it', () => {
    const url = signDocumentUrl(DOC, { expiresAt: new Date(Date.now() + 60_000) });
    const { sig } = paramsOf(url);
    const laterExp = String(Math.floor(Date.now() / 1000) + 86_400);

    expect(verifyDocumentSignature({ documentId: DOC, sig, exp: laterExp })).toBe(false);
  });

  it('rejects a non-numeric exp rather than treating it as absent', () => {
    const { sig } = paramsOf(signDocumentUrl(DOC));
    expect(verifyDocumentSignature({ documentId: DOC, sig, exp: 'never' })).toBe(false);
  });
});
