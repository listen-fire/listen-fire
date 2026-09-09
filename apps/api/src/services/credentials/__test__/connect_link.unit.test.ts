import {
  isOAuthLinkConnectable,
  connectKindForType,
  connectMethodForType,
  humanCredentialName,
  mintConnectLink,
  uniquifyCredentialName,
} from '../connect_link';
import { isKeyEntryConnectable, connectFormSpecForType } from '../connect_form_spec';
import { isIntrinsicProvisionable, intrinsicProvisionerForType } from '../intrinsic_provision';
import { services } from '../../../adapters/registry';
import { resolveOAuthCallbackRedirect } from '../../../lib/oauthCallbackRedirect';
import { bindFlowToUser } from '../../../lib/oauthFlows';
import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';

describe('isOAuthLinkConnectable', () => {
  // NOTE: this gate is (manifest says OAuth credential type) AND (the connector
  // is wired in this process). In the unit context the `services.*` connectors
  // aren't booted, so we can only assert the robust NEGATIVES — adapters that
  // can never be connected via a browser OAuth link regardless of wiring. The
  // positive path is covered by the dev-loop real-path verification.
  it('is false for API-key / non-OAuth adapters', () => {
    // Affinity + Granola use plaintext API tokens; Telegram a bot handshake.
    expect(isOAuthLinkConnectable('affinity')).toBe(false);
    expect(isOAuthLinkConnectable('granola')).toBe(false);
    expect(isOAuthLinkConnectable('telegram')).toBe(false);
  });

  it('is false for credential-free / unknown adapters', () => {
    expect(isOAuthLinkConnectable('knowledge_graph')).toBe(false);
    expect(isOAuthLinkConnectable('not-an-adapter')).toBe(false);
  });
});

describe('key-entry connectability', () => {
  it('marks API-key credential types as key-entry connectable', () => {
    expect(isKeyEntryConnectable(ExternalServiceType.AFFINITY)).toBe(true);
    expect(isKeyEntryConnectable(ExternalServiceType.GRANOLA)).toBe(true);
  });

  it('connectKindForType resolves key-entry for an API-key type', () => {
    // services.* connectors aren't booted in unit context, so OAuth types
    // resolve null here; the key-entry classification is wiring-independent.
    expect(connectKindForType(ExternalServiceType.GRANOLA)).toBe('key-entry');
    expect(connectKindForType(ExternalServiceType.AFFINITY)).toBe('key-entry');
  });

  it('classifies REMOTE as key-entry — a remote adapter secret connects via the form', () => {
    expect(isKeyEntryConnectable(ExternalServiceType.REMOTE)).toBe(true);
    expect(connectKindForType(ExternalServiceType.REMOTE)).toBe('key-entry');
  });

  it('the REMOTE connect form parses a pasted secret into the { secret } payload', () => {
    const spec = connectFormSpecForType(ExternalServiceType.REMOTE);
    expect(spec).toBeDefined();
    expect(spec!.parse({ secret: 'tok-123' })).toEqual({ secret: 'tok-123' });
    // A blank secret is dropped, so the parser rejects the missing key.
    expect(() => spec!.parse({ secret: '   ' })).toThrow();
  });
});

describe('Attio connect kind follows this server’s OAuth wiring', () => {
  // Attio is BOTH: an OAuth adapter where the deployment registered its own
  // Attio app, and a pasted-access-token adapter where it didn't. There is no
  // env check anywhere — the live connector getter decides, so a self-hoster
  // with no ATTIO_CLIENT_ID/SECRET gets the key-entry form.
  const wiredConnector = {
    generateInstallUrl: async () => 'https://attio.example/authorize',
    handleCallback: async () => {},
  } as unknown as NonNullable<typeof services.attio>;

  afterEach(() => {
    services.attio = undefined;
  });

  it('is oauth when the Attio connector is wired', () => {
    services.attio = wiredConnector;
    expect(connectKindForType(ExternalServiceType.ATTIO)).toBe('oauth');
    expect(connectMethodForType(ExternalServiceType.ATTIO)).toBe('oauth');
  });

  it('is key-entry when it is not', () => {
    expect(services.attio).toBeUndefined();
    expect(connectKindForType(ExternalServiceType.ATTIO)).toBe('key-entry');
    expect(connectMethodForType(ExternalServiceType.ATTIO)).toBe('key-entry');
  });
});

describe('intrinsic connectability', () => {
  it('classifies an Listen-Fire-owned credential as intrinsic (both the static method and the mint kind)', () => {
    // services.* connectors aren't booted in unit context, so this stays
    // wiring-independent — intrinsic is pure membership, like key-entry.
    expect(isIntrinsicProvisionable(ExternalServiceType.NATIVE_VALUATIONS)).toBe(true);
    expect(connectMethodForType(ExternalServiceType.NATIVE_VALUATIONS)).toBe('intrinsic');
    expect(connectKindForType(ExternalServiceType.NATIVE_VALUATIONS)).toBe('intrinsic');
    expect(intrinsicProvisionerForType(ExternalServiceType.NATIVE_VALUATIONS)).toBeDefined();
  });

  it('classifies the knowledge graph as intrinsic too — connecting it is a mint, not a paste', () => {
    // The graph is reached over HTTP with a stored credential like any other
    // system (D25), and Listen-Fire owns both ends of that credential.
    expect(isIntrinsicProvisionable(ExternalServiceType.NATIVE_KNOWLEDGE)).toBe(true);
    expect(connectKindForType(ExternalServiceType.NATIVE_KNOWLEDGE)).toBe('intrinsic');
    expect(connectMethodForType(ExternalServiceType.NATIVE_KNOWLEDGE)).toBe('intrinsic');
    expect(intrinsicProvisionerForType(ExternalServiceType.NATIVE_KNOWLEDGE)).toBeDefined();
  });

  it('does not swallow other kinds: telegram stays handshake, key-entry stays key-entry', () => {
    expect(isIntrinsicProvisionable(ExternalServiceType.TELEGRAM)).toBe(false);
    expect(isIntrinsicProvisionable(ExternalServiceType.GRANOLA)).toBe(false);
    expect(connectMethodForType(ExternalServiceType.GRANOLA)).toBe('key-entry');
  });
});

describe('handshake connectability (Telegram)', () => {
  it('classifies TELEGRAM as handshake (both the static method and the mint kind)', () => {
    // Wiring-independent, like key-entry/intrinsic — pure type membership.
    expect(connectMethodForType(ExternalServiceType.TELEGRAM)).toBe('handshake');
    expect(connectKindForType(ExternalServiceType.TELEGRAM)).toBe('handshake');
  });

  it('handshake does not swallow the other kinds', () => {
    expect(connectMethodForType(ExternalServiceType.GRANOLA)).toBe('key-entry');
    expect(connectMethodForType(ExternalServiceType.NATIVE_VALUATIONS)).toBe('intrinsic');
  });

  it('mintConnectLink fails at mint time (no DB write) when the shared bot is unconfigured', async () => {
    // The guard fires before the token insert, so this path never touches the
    // DB — a clear agent-facing error instead of a user landing on a dead page.
    const prev = process.env.TELEGRAM_BOT_USERNAME;
    delete process.env.TELEGRAM_BOT_USERNAME;
    try {
      const result = await mintConnectLink({
        teamId: 'team-1' as never,
        userId: 'user-1' as never,
        adapterSlug: 'telegram',
      });
      expect(result).toEqual({ error: expect.stringMatching(/not configured/i) });
    } finally {
      if (prev === undefined) delete process.env.TELEGRAM_BOT_USERNAME;
      else process.env.TELEGRAM_BOT_USERNAME = prev;
    }
  });
});

describe('humanCredentialName', () => {
  it("formats a possessive name with the adapter's display name", () => {
    expect(humanCredentialName({ memberLabel: 'Alice', adapterDisplayName: 'Granola' })).toBe(
      "Alice's Granola",
    );
  });

  it('capitalises a lowercase member label', () => {
    expect(humanCredentialName({ memberLabel: 'alice', adapterDisplayName: 'Granola' })).toBe(
      "Alice's Granola",
    );
  });

  it('output contains no underscores', () => {
    const result = humanCredentialName({ memberLabel: 'alice', adapterDisplayName: 'Granola' });
    expect(result).not.toContain('_');
  });

  it('works with a multi-word display name', () => {
    expect(humanCredentialName({ memberLabel: 'bob', adapterDisplayName: 'Google Drive' })).toBe(
      "Bob's Google Drive",
    );
  });
});

describe('uniquifyCredentialName', () => {
  it('returns the base name when not already taken', () => {
    expect(uniquifyCredentialName("Alice's Granola", new Set())).toBe("Alice's Granola");
  });

  it('appends (2) when the base name is taken', () => {
    expect(uniquifyCredentialName("Alice's Granola", new Set(["Alice's Granola"]))).toBe(
      "Alice's Granola (2)",
    );
  });

  it('two members resolving to the same base name get distinct names', () => {
    // Member 1 has already claimed the base name.
    const takenAfterMember1 = new Set(["Alice's Granola"]);
    const nameForMember2 = uniquifyCredentialName("Alice's Granola", takenAfterMember1);

    expect(nameForMember2).not.toBe("Alice's Granola");
    expect(nameForMember2).toBe("Alice's Granola (2)");
  });

  it('keeps incrementing past existing disambiguated names', () => {
    const taken = new Set(["Alice's Granola", "Alice's Granola (2)", "Alice's Granola (3)"]);
    expect(uniquifyCredentialName("Alice's Granola", taken)).toBe("Alice's Granola (4)");
  });
});

describe('resolveOAuthCallbackRedirect', () => {
  it('routes the popup flow to the connector web callback (no connectToken)', () => {
    const url = resolveOAuthCallbackRedirect({
      state: 'state-popup',
      claimToken: 'claim-abc',
      callbackUrl: 'http://localhost:3003/attio/callback',
    });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('http://localhost:3003/attio/callback');
    expect(parsed.searchParams.get('claimToken')).toBe('claim-abc');
  });

  it('routes the connect-LINK flow to the /complete landing route (connectToken bound)', () => {
    bindFlowToUser('state-link', 'user-1', { connectToken: 'connect-tok' });
    const url = resolveOAuthCallbackRedirect({
      state: 'state-link',
      claimToken: 'claim-xyz',
      callbackUrl: 'http://localhost:3003/attio/callback',
    });
    const parsed = new URL(url);
    expect(parsed.pathname).toBe('/api/connect/connect-tok/complete');
    expect(parsed.searchParams.get('claimToken')).toBe('claim-xyz');
  });
});
