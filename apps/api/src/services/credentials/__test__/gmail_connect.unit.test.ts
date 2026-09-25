// Connecting a Gmail mailbox: the one-field form, the credential shape it
// stores, the discriminator that keeps it apart from the retired sign-in, and
// the mapping from a refused call to the message the user reads.

jest.mock('../../../adapters/gmail/apiClient', () => {
  const actual = jest.requireActual('../../../adapters/gmail/apiClient');
  return { ...actual, validateGmailMailbox: jest.fn() };
});

import ExternalServiceType from '../../../generated/kysely/automations/ExternalServiceType';
import {
  GMAIL_DELEGATION_MESSAGE,
  GMAIL_NO_MAILBOX_MESSAGE,
  classifyGmailError,
  validateGmailMailbox,
} from '../../../adapters/gmail/apiClient';
import {
  GMAIL_APP_ID,
  defaultAppIdForType,
  gmailCredentialShape,
  isDelegatedGmail,
} from '../app_id';
import { connectFormSpecForType, isKeyEntryConnectable } from '../connect_form_spec';

const validateMock = jest.mocked(validateGmailMailbox);

const priorMethod = process.env.GMAIL_CONNECT_METHOD;

/** The form belongs to the DELEGATED method, so every test of it says so —
 *  under the default `oauth` method nobody types an address at all. */
beforeEach(() => {
  process.env.GMAIL_CONNECT_METHOD = 'delegated';
});

afterEach(() => {
  if (priorMethod === undefined) delete process.env.GMAIL_CONNECT_METHOD;
  else process.env.GMAIL_CONNECT_METHOD = priorMethod;
});

describe('the Gmail connect form', () => {
  it('is key-entry connectable with one visible, non-secret field', () => {
    expect(isKeyEntryConnectable(ExternalServiceType.GOOGLE_GMAIL)).toBe(true);
    const spec = connectFormSpecForType(ExternalServiceType.GOOGLE_GMAIL);
    expect(spec?.fields.map((f) => f.name)).toEqual(['mailbox']);
    expect(spec?.fields[0]).toMatchObject({ secret: false, optional: false });
  });

  it('asks for a refresh token, not an address, when the deployment signs in as the mailbox', () => {
    process.env.GMAIL_CONNECT_METHOD = 'oauth';
    const spec = connectFormSpecForType(ExternalServiceType.GOOGLE_GMAIL);
    expect(spec?.fields.map((f) => f.name)).toEqual(['refreshToken']);
    // The token IS the mailbox, so it is never echoed back onto the form.
    expect(spec?.fields[0]).toMatchObject({ secret: true, optional: false });
  });

  it('stores only the address — there is no token to keep', () => {
    const spec = connectFormSpecForType(ExternalServiceType.GOOGLE_GMAIL)!;
    expect(spec.parse({ mailbox: '  deals@example.com  ' })).toEqual({
      mailbox: 'deals@example.com',
    });
  });

  it('rejects something that is not an address before anything is called', () => {
    const spec = connectFormSpecForType(ExternalServiceType.GOOGLE_GMAIL)!;
    expect(() => spec.parse({ mailbox: 'the sales inbox' })).toThrow();
  });

  it('runs the live check and passes its message through', async () => {
    const spec = connectFormSpecForType(ExternalServiceType.GOOGLE_GMAIL)!;
    validateMock.mockResolvedValueOnce({ ok: false, message: GMAIL_DELEGATION_MESSAGE });
    await expect(spec.validate?.({ mailbox: 'deals@example.com' })).resolves.toEqual({
      ok: false,
      message: GMAIL_DELEGATION_MESSAGE,
    });
  });
});

describe('telling a refused call apart', () => {
  it('reads an impersonation Google never agreed to as a delegation failure', () => {
    const err = Object.assign(new Error('unauthorized_client: Client is unauthorized'), {
      status: 401,
    });
    expect(classifyGmailError(err, 'users.getProfile').failure).toBe('delegation');
  });

  it('reads a 403 from Gmail itself as a delegation failure too', () => {
    expect(classifyGmailError({ response: { status: 403 } }, 'users.getProfile').failure).toBe(
      'delegation',
    );
  });

  it('reads a 404 on an impersonated profile as "not a mailbox"', () => {
    const err = { response: { status: 404, data: { error: { message: 'Not Found' } } } };
    expect(classifyGmailError(err, 'users.getProfile').failure).toBe('no_such_mailbox');
  });

  it('reads a 404 on history as an expired marker, not a missing mailbox', () => {
    const err = { response: { status: 404 } };
    expect(classifyGmailError(err, 'history.list').failure).toBe('history_expired');
  });

  it('leaves anything else as itself rather than guessing', () => {
    expect(classifyGmailError({ response: { status: 500 } }, 'users.getProfile').failure).toBe(
      'other',
    );
  });

  it('has a plain sentence for each of the two connect-time failures', () => {
    expect(GMAIL_DELEGATION_MESSAGE).toMatch(/domain wide delegation/);
    expect(GMAIL_NO_MAILBOX_MESSAGE).toMatch(/not a mailbox/);
  });
});

describe('the credential discriminator', () => {
  it('marks a freshly connected mailbox with the shape this installation mints', () => {
    expect(defaultAppIdForType(ExternalServiceType.GOOGLE_GMAIL)).toBe(
      GMAIL_APP_ID.delegatedMailbox,
    );
    expect(isDelegatedGmail(defaultAppIdForType(ExternalServiceType.GOOGLE_GMAIL))).toBe(true);

    process.env.GMAIL_CONNECT_METHOD = 'oauth';
    expect(defaultAppIdForType(ExternalServiceType.GOOGLE_GMAIL)).toBe(GMAIL_APP_ID.oauthMailbox);
  });

  it('reads each live shape as itself', () => {
    expect(gmailCredentialShape(GMAIL_APP_ID.delegatedMailbox)).toBe('delegated');
    expect(gmailCredentialShape(GMAIL_APP_ID.oauthMailbox)).toBe('oauth');
  });

  it('reads a row from the retired sign-in — including a pre-discriminator null — as not a mailbox', () => {
    expect(isDelegatedGmail(null)).toBe(false);
    expect(isDelegatedGmail(GMAIL_APP_ID.legacySignIn)).toBe(false);
    expect(gmailCredentialShape(null)).toBeNull();
    expect(gmailCredentialShape(GMAIL_APP_ID.legacySignIn)).toBeNull();
  });
});
