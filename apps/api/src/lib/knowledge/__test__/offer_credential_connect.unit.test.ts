import { buildCredentialConnectOffer, offersToSuggestedActions } from '../unified_agent';

describe('offerCredentialConnect', () => {
  it('offers a connect action for a known, unconnected adapter', async () => {
    const offer = await buildCredentialConnectOffer({
      adapterSlug: 'attio',
      hasCredentialOfType: async () => false,
    });
    expect(offer).toMatchObject({ adapter: 'attio', alreadyConnected: false });
    expect((offer as any).displayName).toBeTruthy();
    expect((offer as any).serviceType).toBeTruthy();
  });

  it('reports already-connected when the team has the credential', async () => {
    const offer = await buildCredentialConnectOffer({
      adapterSlug: 'attio',
      hasCredentialOfType: async () => true,
    });
    expect((offer as any).alreadyConnected).toBe(true);
  });

  it('errors for an unknown adapter', async () => {
    const offer = await buildCredentialConnectOffer({
      adapterSlug: 'definitely-not-an-adapter',
      hasCredentialOfType: async () => false,
    });
    expect('error' in offer).toBe(true);
  });
});

describe('offersToSuggestedActions', () => {
  it('maps unconnected offers to connect-credential actions and drops connected ones', () => {
    const actions = offersToSuggestedActions([
      { adapter: 'attio', displayName: 'Attio', serviceType: 'ATTIO', alreadyConnected: false },
      { adapter: 'gmail', displayName: 'Gmail', serviceType: 'GOOGLE_GMAIL', alreadyConnected: true },
    ]);
    expect(actions).toEqual([
      { label: 'Connect Attio', message: '', connectAction: { kind: 'connect-credential', adapter: 'attio', serviceType: 'ATTIO' } },
    ]);
  });
});
