import { encryptToken, decryptToken, CredentialReconnectRequiredError } from '../credentials';

/**
 * The shell-credential refusal (D30(b), D54(i)).
 *
 * This is the one place that can state the rule once — every adapter reaches
 * decryption through this function — so the test that matters is that a shell
 * is refused BY NAME rather than falling into the cipher, where it would
 * surface as an opaque GCM failure naming neither the connection nor the fix.
 */

const CONTEXT = '29f24531-7689-4137-ac21-a1431852ccb5';

beforeAll(() => {
  process.env.ENCRYPTION_MASTER_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.ENCRYPTION_SALT_BASE64 = Buffer.alloc(32, 9).toString('base64');
});

describe('decryptToken', () => {
  it('round-trips a real credential', async () => {
    const cipher = await encryptToken(JSON.stringify({ apiKey: 'lf_x' }), CONTEXT);
    expect(JSON.parse(await decryptToken(cipher, CONTEXT))).toEqual({ apiKey: 'lf_x' });
  });

  it('refuses a SHELL — a row with no ciphertext — and names the credential', async () => {
    await expect(decryptToken(null, CONTEXT)).rejects.toBeInstanceOf(
      CredentialReconnectRequiredError,
    );
    await expect(decryptToken(null, CONTEXT)).rejects.toThrow(/must be reconnected/);
    await expect(decryptToken(null, CONTEXT)).rejects.toThrow(CONTEXT);
  });

  it('refuses an EMPTY buffer the same way — no bytes is no credential, however it got there', async () => {
    await expect(decryptToken(Buffer.alloc(0), CONTEXT)).rejects.toBeInstanceOf(
      CredentialReconnectRequiredError,
    );
  });

  it('still fails a tampered credential in the cipher, not as a reconnect', async () => {
    const cipher = await encryptToken('secret', CONTEXT);
    cipher[cipher.length - 1] ^= 0xff;
    await expect(decryptToken(cipher, CONTEXT)).rejects.not.toBeInstanceOf(
      CredentialReconnectRequiredError,
    );
  });
});
