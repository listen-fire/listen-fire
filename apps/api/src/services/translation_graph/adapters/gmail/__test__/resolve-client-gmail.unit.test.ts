// resolveGmailClient — the delegated client built at USE time: the third of
// the three mailbox-allowlist enforcement sites (connect-time validation and
// the in-app modal's save path are the other two, both in apiClient.ts /
// credentials.ts). A stored credential whose mailbox has since fallen off —
// or never was on — this installation's GMAIL_MAILBOX_ALLOWLIST must stop
// working immediately, with the run's error saying why.

jest.mock('../../../../../lib/google_cloud', () => {
  const actual = jest.requireActual('../../../../../lib/google_cloud');
  return { ...actual, delegatedGoogleAuth: jest.fn(() => ({ __stub: 'delegated-auth' })) };
});
jest.mock('googleapis', () => ({
  google: {
    gmail: () => ({
      users: {
        getProfile: jest.fn(),
        messages: { send: jest.fn(), list: jest.fn(), get: jest.fn(), attachments: { get: jest.fn() } },
        history: { list: jest.fn() },
      },
    }),
  },
}));

jest.mock('../../../../../lib/credentials', () => ({
  decryptToken: async () => JSON.stringify({ mailbox: 'deals@example.com' }),
}));
jest.mock('../../../../../lib/recording', () => ({
  isTestHarnessTeam: () => false,
  injectFakeBaseUrl: (creds: unknown) => creds,
}));
jest.mock('../../../../credentials/app_id', () => ({
  isDelegatedGmail: () => true,
}));
jest.mock('../../../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => ({
      where: () => ({
        where: () => ({
          select: () => ({
            executeTakeFirst: async () => ({
              id: 'cred-1',
              credentials: Buffer.from('enc'),
              app_id: 'delegated-mailbox',
            }),
          }),
        }),
      }),
    }),
  }),
}));

import type { TeamId } from '../../../../../generated/kysely/core/Team';
import { resolveGmailClient } from '../client';

const TEAM = 'team-1' as TeamId;

describe('resolveGmailClient — the allowlist enforced at use time', () => {
  const prior = process.env.GMAIL_MAILBOX_ALLOWLIST;

  afterEach(() => {
    if (prior === undefined) delete process.env.GMAIL_MAILBOX_ALLOWLIST;
    else process.env.GMAIL_MAILBOX_ALLOWLIST = prior;
  });

  it('throws, naming the mailbox and the variable, when a real credential is not on the allowlist', async () => {
    delete process.env.GMAIL_MAILBOX_ALLOWLIST;
    await expect(resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' })).rejects.toThrow(
      /GMAIL_MAILBOX_ALLOWLIST/,
    );
    await expect(resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' })).rejects.toThrow(
      /deals@example\.com/,
    );
  });

  it('builds a client once the credential’s mailbox is on the allowlist', async () => {
    process.env.GMAIL_MAILBOX_ALLOWLIST = 'deals@example.com';
    const client = await resolveGmailClient({ teamId: TEAM, credentialsId: 'cred-1' });
    expect(client).not.toBeNull();
  });
});
