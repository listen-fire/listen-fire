import { hkdf, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

import { getEnvVar } from './utils/environment';

// Read the env-backed key material lazily and memoize it. Doing this at
// module load would force every importer of this file — transitively, the
// whole adapter chain — to have ENCRYPTION_MASTER_KEY set just to be loaded,
// even when they never decrypt. Deferring to first use keeps the side effect
// where it belongs: the actual encrypt/decrypt path.
let keyMaterial: { masterKey: Buffer; salt: Buffer } | undefined;

function getKeyMaterial() {
  if (!keyMaterial) {
    keyMaterial = {
      masterKey: Buffer.from(getEnvVar('ENCRYPTION_MASTER_KEY'), 'base64'),
      salt: Buffer.from(getEnvVar('ENCRYPTION_SALT_BASE64'), 'base64'),
    };
  }
  return keyMaterial;
}

async function deriveDEK(context: string) {
  const { masterKey, salt } = getKeyMaterial();
  return new Promise<Buffer>((resolve, reject) => {
    hkdf('sha256', masterKey, salt, Buffer.from(context), 32, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(Buffer.from(derivedKey));
    });
  });
}

async function encryptToken(plaintext: string, context: string) {
  const key = await deriveDEK(context);
  const nonce = randomBytes(12); // 96-bit IV for AES-GCM
  const cipher = createCipheriv('aes-256-gcm', key, nonce);

  const aad = Buffer.from(context);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // store nonce + ciphertext + tag, base64-encoded
  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * Thrown when a credential row exists but carries no ciphertext — a SHELL,
 * written by a per-team import (D30(b), ST-4). The row is deliberately there:
 * `trigger.credentials_id` and `webhook_subscription.credentials_id` point at
 * it, so deleting it would strand the movements that name the connection.
 *
 * It is its own error type because every caller reaches decryption through
 * this one function, so this is the only place that can state the rule once —
 * and because the alternative (letting an empty buffer fall into the cipher)
 * surfaces as an opaque GCM failure, which tells the operator nothing about
 * the one action that fixes it.
 */
class CredentialReconnectRequiredError extends Error {
  constructor(readonly credentialsId: string) {
    super(
      `Connection ${credentialsId} was migrated without its secret and must be reconnected before it can be used.`,
    );
    this.name = 'CredentialReconnectRequiredError';
  }
}

async function decryptToken(data: Buffer | null, context: string) {
  if (data === null || data.length === 0) {
    throw new CredentialReconnectRequiredError(context);
  }

  const nonce = data.subarray(0, 12);
  const tag = data.subarray(data.length - 16);
  const ciphertext = data.subarray(12, data.length - 16);

  const key = await deriveDEK(context);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  const aad = Buffer.from(context);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

export { encryptToken, decryptToken, CredentialReconnectRequiredError };
