import { randomBytes, createHash } from 'node:crypto';

import { z } from 'zod';
import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import { logger } from '../../services/logger';
import { encryptToken } from '../../lib/credentials';
import { getAutomationsQb } from '../../lib/kysely';
import { ExternalServiceCredentialsId } from '../../generated/kysely/automations/ExternalServiceCredentials';

const scopes = [
  'https://www.googleapis.com/auth/gmail.readonly',
];

const gmailCredsParser = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.number(),
});

class GmailAuthClient {
  private authCache: Record<string, string> = {};
  private oauth2Client: OAuth2Client;
  private clientId: string;
  private clientSecret: string;
  private clientsById: Record<string, OAuth2Client> = {};
  readonly callbackUrl: string;

  constructor({ clientId, clientSecret, redirectBaseUrl }: { clientId: string; clientSecret: string; redirectBaseUrl: string }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.callbackUrl = `${redirectBaseUrl}/gmail/callback`;
    this.oauth2Client = new OAuth2Client({
      clientId,
      clientSecret,
      redirectUri: this.callbackUrl,
    });
  }

  getGmailClient(id: string, creds: z.infer<typeof gmailCredsParser>): OAuth2Client {
    if (!this.clientsById[id]) {
      const client = new OAuth2Client({
        clientId: this.clientId,
        clientSecret: this.clientSecret,
      });
      client.setCredentials({
        access_token: creds.accessToken,
        refresh_token: creds.refreshToken,
        expiry_date: creds.expiresAt,
      });
      this.clientsById[id] = client;

      this.clientsById[id].on('tokens', async (tokens) => {
        logger.info('[GMAIL] SAVING CREDENTIALS');
        if (!tokens.access_token || !tokens.expiry_date) {
          logger.error('[GMAIL] Token refresh missing required fields');
          throw new Error('Invalid token received');
        }

        const newSavedCreds: z.infer<typeof gmailCredsParser> = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? creds.refreshToken,
          expiresAt: tokens.expiry_date,
        };

        const encrypted = await encryptToken(JSON.stringify(newSavedCreds), id);
        await getAutomationsQb(['external_service_credentials'])
          .updateTable('external_service_credentials')
          .set({
            credentials: encrypted,
            updated_at: new Date(),
          })
          .where('id', '=', id as ExternalServiceCredentialsId)
          .execute();
        logger.info('[GMAIL] CREDENTIALS SAVED');
      });
    }

    return this.clientsById[id];
  }

  removeClient(id: string) {
    delete this.clientsById[id];
  }

  async revokeToken(creds: z.infer<typeof gmailCredsParser>): Promise<void> {
    try {
      await this.oauth2Client.revokeToken(creds.accessToken);
      logger.info('[GMAIL] Token revoked at Google');
    } catch (err) {
      logger.error('[GMAIL] Failed to revoke token at Google');
      throw err;
    }
  }

  async codeToToken({
    state,
    code,
  }: {
    state: string;
    code: string;
  }): Promise<z.infer<typeof gmailCredsParser>> {
    const codeVerifier = this.authCache[state];
    if (!codeVerifier) {
      throw new Error('Invalid state parameter value');
    }

    delete this.authCache[state];

    const { tokens } = await this.oauth2Client.getToken({
      code,
      codeVerifier,
    });

    if (!tokens.access_token || !tokens.refresh_token || !tokens.expiry_date) {
      logger.error('[GMAIL] Token exchange missing required fields');
      throw new Error('Invalid token received');
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expiry_date,
    };
  }

  async generateInstallUrl(): Promise<string> {
    const state = randomBytes(100).toString('base64url');
    const codeVerifier = randomBytes(96).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/=/g, '')
      .replace(/\+/g, '-')
      .replace(/\//g, '_');

    this.authCache[state] = codeVerifier;
    setTimeout(
      () => {
        delete this.authCache[state];
      },
      1000 * 60 * 15,
    );

    return this.oauth2Client.generateAuthUrl({
      state,
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      scope: scopes,
    });
  }
}

export { GmailAuthClient, gmailCredsParser };
