import { mintGrantAccessLink } from '../grant_access';
import { mintItemPickerLink } from '../connect_link';

jest.mock('../../translation_graph/adapters/registry', () => ({
  getAdapterManifest: (slug: string) =>
    slug === 'google_sheets'
      ? { adapterType: 'google_sheets', construction: [{ kind: 'action', actionKind: 'google-sheets-picker', label: 'Connect a Google Sheet' }] }
      : slug === 'attio'
        ? { adapterType: 'attio' }
        : null,
}));
jest.mock('../connect_link', () => ({
  mintItemPickerLink: jest.fn(async () => ({ url: 'https://x', credentialName: 'google_sheets', expiresAt: new Date() })),
}));

const mintItemPickerLinkMock = mintItemPickerLink as jest.Mock;

describe('mintGrantAccessLink', () => {
  const base = { teamId: 't' as never, userId: 'u' as never };

  beforeEach(() => {
    mintItemPickerLinkMock.mockClear();
  });

  it('dispatches google_sheets to the picker minting with its action kind', async () => {
    const result = await mintGrantAccessLink({ ...base, system: 'google_sheets' });
    expect('url' in result && result.url).toBe('https://x');
    // The action kind drives the slug/spec inside mintItemPickerLink, so the
    // manifest's value must reach it verbatim (a stale value would mint the
    // wrong adapter's picker).
    expect(mintItemPickerLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({ actionKind: 'google-sheets-picker' }),
    );
  });
  it('passes a named connection through as credentialName', async () => {
    await mintGrantAccessLink({ ...base, system: 'google_sheets', connection: 'work-google' });
    expect(mintItemPickerLinkMock).toHaveBeenCalledWith(
      expect.objectContaining({ credentialName: 'work-google' }),
    );
  });
  it('omits credentialName entirely when no connection is named', async () => {
    await mintGrantAccessLink({ ...base, system: 'google_sheets' });
    const callArgs = mintItemPickerLinkMock.mock.calls[0][0];
    expect(callArgs).not.toHaveProperty('credentialName');
  });
  it('explains when a system has no per-item grant flow', async () => {
    const result = await mintGrantAccessLink({ ...base, system: 'attio' });
    expect('error' in result && result.error).toMatch(/doesn't need per-item grants/);
  });
  it('errors on an unknown system', async () => {
    const result = await mintGrantAccessLink({ ...base, system: 'nope' });
    expect('error' in result && result.error).toMatch(/No connected system type/);
  });
});
