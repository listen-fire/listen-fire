// The module's side of its credential: the declarations it answers with, and
// how the fields a host hands it become a client.

import { emptyOcrSlot, loadedModule, moduleManifest, refusingFiles, refusingIdentities, refusingKv, refusingModels } from 'module-kit';
import { emptyBrowserSlot } from 'movement-engine/public/browser';

import { GMAIL_COMPOSE_SCOPE, GMAIL_DRAFTS_SCOPES, GMAIL_SCOPES, GMAIL_SEND_SCOPE } from '../api_client';
import { gmailClientFromFields } from '../credential';
import { gmailModule } from '../index';
import { silentLog } from './host';

describe('the declarations', () => {
  it('declares its credential and its poll, and pairs the poll with a method', () => {
    const credential = { name: 'gmail', fields: async () => ({}), update: async () => undefined };
    const manifest = moduleManifest(
      loadedModule(gmailModule, {
        credential,
        spend: { charge: () => undefined },
        fetch,
        log: silentLog,
        files: refusingFiles('none'),
        kv: refusingKv('none'),
        models: refusingModels('none'),
        identities: refusingIdentities('none'),
        browser: emptyBrowserSlot('none'),
        ocr: emptyOcrSlot('none'),
        config: { tenant: 't', constructionArgs: {} },
      }),
    );
    expect(manifest.adapterType).toBe('gmail');
    expect(manifest.poll).toEqual({ intervalSeconds: 60 });
    expect(manifest.methods).toContain('poll');
    expect(manifest.inbound).toBeUndefined();
    expect(manifest.credentials?.[0]).toMatchObject({ name: 'gmail', kind: 'oauth2', oauth2: { scopes: [...GMAIL_SCOPES], clientAuth: 'body', pkce: true } });
    // Drafts are opted into by signing in with the second declaration, the
    // only one that asks for the compose scope.
    expect(manifest.credentials?.[1]).toMatchObject({ name: 'gmail_drafts', kind: 'oauth2', oauth2: { scopes: [...GMAIL_DRAFTS_SCOPES] } });
    expect(GMAIL_SCOPES).not.toContain(GMAIL_COMPOSE_SCOPE);
    expect(GMAIL_DRAFTS_SCOPES).toContain(GMAIL_COMPOSE_SCOPE);
  });
});

describe('fields to a client', () => {
  const base = { mailbox: 'deals@example.com', access_token: 'tok' };

  it('reads a sign-in with no granted scopes as holding the ones it asks for', () => {
    expect(gmailClientFromFields(base, { fetch }).canSend()).toBe(true);
    expect(gmailClientFromFields({ ...base, granted_scopes: 'https://www.googleapis.com/auth/gmail.readonly' }, { fetch }).canSend()).toBe(false);
    expect(gmailClientFromFields({ ...base, granted_scopes: GMAIL_SCOPES.join(' ') }, { fetch }).credentials.grantedScopes).toContain(GMAIL_SEND_SCOPE);
  });

  it('may draft only where the sign-in holds the compose scope', async () => {
    expect(gmailClientFromFields(base, { fetch }).canDraft()).toBe(false);
    expect(gmailClientFromFields(base, { fetch, declared: 'gmail_drafts' }).canDraft()).toBe(true);
    expect(gmailClientFromFields({ ...base, granted_scopes: GMAIL_DRAFTS_SCOPES.join(' ') }, { fetch }).canDraft()).toBe(true);
    expect(gmailClientFromFields({ ...base, granted_scopes: GMAIL_SCOPES.join(' ') }, { fetch, declared: 'gmail_drafts' }).canDraft()).toBe(false);
    await expect(gmailClientFromFields(base, { fetch }).createDraft({ raw: 'cmF3' })).rejects.toMatchObject({ failure: 'missing_compose_scope' });
  });

  it('refuses a delegated draft the host holds no compose token for, naming why', async () => {
    const client = gmailClientFromFields({ ...base, method: 'delegated', compose_refusal: 'unauthorized_client' }, { fetch, declared: 'gmail_drafts' });
    await expect(client.createDraft({ raw: 'cmF3' })).rejects.toMatchObject({ failure: 'missing_compose_scope', message: expect.stringMatching(/unauthorized_client/) });
  });

  it('refuses fields that name no mailbox or hold no token, and a method it does not know', () => {
    expect(() => gmailClientFromFields({ access_token: 'tok' }, { fetch })).toThrow(/Connect Gmail/);
    expect(() => gmailClientFromFields({ mailbox: 'deals@example.com' }, { fetch })).toThrow(/Connect Gmail/);
    expect(() => gmailClientFromFields({ ...base, method: 'delegation' }, { fetch })).toThrow(/'delegation'/);
  });

  it('refuses a delegated send the host holds no token for, naming why, with the delegated remedy', async () => {
    const client = gmailClientFromFields({ ...base, method: 'delegated', send_refusal: 'unauthorized_client' }, { fetch });
    await expect(client.sendMessage({ raw: 'cmF3' })).rejects.toMatchObject({ failure: 'missing_send_scope', message: expect.stringMatching(/unauthorized_client/) });
  });
});
