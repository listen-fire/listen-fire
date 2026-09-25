// Which Gmail controls the connections modal shows. The server reports how it
// connects Gmail; the modal must offer exactly that, and never a form it would
// refuse to save.

import { gmailConnectControls } from '../gmail-connect';

describe('gmailConnectControls', () => {
  it('offers the sign-in AND the paste when the deployment signs in as the mailbox', () => {
    expect(gmailConnectControls({ method: 'oauth', signIn: true })).toEqual({
      signIn: true,
      refreshToken: true,
      mailbox: false,
    });
  });

  it('offers only the mailbox field when the deployment acts as the mailbox instead', () => {
    expect(gmailConnectControls({ method: 'delegated', signIn: false })).toEqual({
      signIn: false,
      refreshToken: false,
      mailbox: true,
    });
  });

  it('offers nothing when the sign-in deployment registered no OAuth client', () => {
    // The paste redeems through that same client, so it cannot stand in for it.
    expect(gmailConnectControls({ method: 'oauth', signIn: false })).toEqual({
      signIn: false,
      refreshToken: false,
      mailbox: false,
    });
  });

  it('offers nothing before the server has answered', () => {
    expect(gmailConnectControls(undefined)).toEqual({
      signIn: false,
      refreshToken: false,
      mailbox: false,
    });
  });
});
