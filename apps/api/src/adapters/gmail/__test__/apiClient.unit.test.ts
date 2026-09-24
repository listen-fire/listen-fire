// The Gmail wire client: the mailbox allowlist gate every enforcement site
// shares, the per-operation scope split (a delegation that covers reads but
// not sends must not fail the reads), and how a refused token is told apart
// by which scope set it was requesting.

const delegatedAuthCalls: { subject: string; scopes: readonly string[] }[] = [];
jest.mock('../../../lib/google_cloud', () => {
  const actual = jest.requireActual('../../../lib/google_cloud');
  return {
    ...actual,
    delegatedGoogleAuth: jest.fn((input: { subject: string; scopes: readonly string[] }) => {
      delegatedAuthCalls.push({ subject: input.subject, scopes: input.scopes });
      return { __marker: 'delegated-auth', subject: input.subject, scopes: input.scopes };
    }),
  };
});

interface BuiltApi {
  auth: unknown;
  users: {
    getProfile: jest.Mock;
    messages: { send: jest.Mock };
  };
}
const built: BuiltApi[] = [];
const gmailFactory = jest.fn((opts: { auth: unknown }) => {
  const api: BuiltApi = {
    auth: opts.auth,
    users: {
      getProfile: jest.fn().mockResolvedValue({
        data: { emailAddress: 'deals@example.com', historyId: '1' },
      }),
      messages: {
        send: jest.fn().mockResolvedValue({ data: { id: 'sent-1' } }),
      },
    },
  };
  built.push(api);
  return api;
});
jest.mock('googleapis', () => ({
  google: { gmail: (opts: { auth: unknown }) => gmailFactory(opts) },
}));

import { GMAIL_READONLY_SCOPE, GMAIL_SEND_SCOPE } from '../../../lib/google_cloud';
import {
  GMAIL_DELEGATION_MESSAGE,
  GmailApiClient,
  checkGmailMailboxAllowed,
  classifyGmailError,
  gmailMissingSendScopeMessage,
  validateGmailMailbox,
} from '../apiClient';

const ALLOWED_ENV = { GMAIL_MAILBOX_ALLOWLIST: 'deals@example.com,ops@example.com' };

beforeEach(() => {
  delegatedAuthCalls.length = 0;
  built.length = 0;
  gmailFactory.mockClear();
});

describe('checkGmailMailboxAllowed', () => {
  it('names the variable and refuses everything when it is unset', () => {
    const verdict = checkGmailMailboxAllowed('deals@example.com', {});
    expect(verdict).toEqual({
      ok: false,
      message: expect.stringContaining('GMAIL_MAILBOX_ALLOWLIST'),
    });
    if (!verdict.ok) {
      expect(verdict.message).toMatch(/is not set/);
    }
  });

  it('treats an empty string the same as unset', () => {
    expect(checkGmailMailboxAllowed('deals@example.com', { GMAIL_MAILBOX_ALLOWLIST: '' })).toEqual(
      { ok: false, message: expect.stringContaining('GMAIL_MAILBOX_ALLOWLIST') },
    );
  });

  it('refuses a mailbox the list does not name, naming the mailbox and the variable', () => {
    const verdict = checkGmailMailboxAllowed('someoneelse@example.com', ALLOWED_ENV);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.message).toContain('someoneelse@example.com');
      expect(verdict.message).toContain('GMAIL_MAILBOX_ALLOWLIST');
    }
  });

  it('allows a listed mailbox regardless of case or surrounding whitespace', () => {
    expect(checkGmailMailboxAllowed(' Deals@Example.com ', ALLOWED_ENV)).toEqual({ ok: true });
  });
});

describe('validateGmailMailbox — the allowlist gate runs before Google is ever asked', () => {
  it('refuses an unlisted mailbox without needing a service account configured', async () => {
    await expect(
      validateGmailMailbox({ mailbox: 'someoneelse@example.com' }),
    ).resolves.toEqual({
      ok: false,
      message: expect.stringContaining('GMAIL_MAILBOX_ALLOWLIST'),
    });
    expect(gmailFactory).not.toHaveBeenCalled();
  });
});

describe('classifyGmailError — which scope set was being requested', () => {
  it('reads a token refusal on the send call as a missing send scope', () => {
    const err = Object.assign(new Error('unauthorized_client'), { status: 403 });
    expect(classifyGmailError(err, 'users.messages.send').failure).toBe('missing_send_scope');
  });

  it('reads the identical refusal on a read call as general delegation', () => {
    const err = Object.assign(new Error('unauthorized_client'), { status: 403 });
    expect(classifyGmailError(err, 'users.getProfile').failure).toBe('delegation');
  });

  it('has a plain sentence for the missing-send-scope failure naming the mailbox, the scope, and that reads are unaffected', () => {
    const message = gmailMissingSendScopeMessage('deals@example.com');
    expect(message).toContain('deals@example.com');
    expect(message).toContain(GMAIL_SEND_SCOPE);
    expect(message).toMatch(/reads still work/i);
  });

  it('leaves the two connect-time messages distinct from the send one', () => {
    expect(GMAIL_DELEGATION_MESSAGE).not.toContain(GMAIL_SEND_SCOPE);
  });
});

describe('GmailApiClient — each call asks for only the scope it needs', () => {
  it('builds a readonly-scoped client and a send-scoped client up front', () => {
    // eslint-disable-next-line no-new
    new GmailApiClient({ mailbox: 'deals@example.com' });
    expect(delegatedAuthCalls).toEqual([
      { subject: 'deals@example.com', scopes: [GMAIL_READONLY_SCOPE] },
      { subject: 'deals@example.com', scopes: [GMAIL_SEND_SCOPE] },
    ]);
  });

  it('reads through the readonly-scoped client only, never the send-scoped one', async () => {
    const client = new GmailApiClient({ mailbox: 'deals@example.com' });
    const [readApi, sendApi] = built;

    await client.getProfile();

    expect(readApi.users.getProfile).toHaveBeenCalledTimes(1);
    expect(sendApi.users.messages.send).not.toHaveBeenCalled();
  });

  it('sends through the send-scoped client only, never the readonly-scoped one', async () => {
    const client = new GmailApiClient({ mailbox: 'deals@example.com' });
    const [readApi, sendApi] = built;

    await client.sendMessage({ raw: 'cmF3' });

    expect(sendApi.users.messages.send).toHaveBeenCalledTimes(1);
    expect(readApi.users.getProfile).not.toHaveBeenCalled();
  });
});
