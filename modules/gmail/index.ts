// `@lf/gmail`: one Gmail mailbox as a module. The host hands it the install's
// credential (the mailbox and its tokens, kept fresh by the host: the module
// never refreshes, and never sees a service account key), a fetch, and its
// files (the bytes of a file a send is handed without a url).
// `ctx.config.baseUrlOverride` (the dev loop's fake) replaces Google's root
// URL. googleapis builds the requests; gaxios sends them through `ctx.fetch`.
// Arriving mail and labels are its two polled edges (`Messages`,
// `Labelings`); there is no push route.

import { defineModule, readHandedFile, type PollEdgeInput, type PollInput } from 'module-kit';

import { GmailAdapter } from './adapter';
import { GMAIL_CREDENTIAL, GMAIL_DRAFTS_CREDENTIAL, gmailClientFrom } from './credential';
import { GMAIL_MANIFEST } from './manifest';
import { GmailPollSource } from './poll';
import { GMAIL_POLL_EVERY_SECONDS } from './types';

export const gmailModule = defineModule({
  kind: 'adapter',
  name: '@lf/gmail',
  manifest: GMAIL_MANIFEST,
  credentials: [GMAIL_CREDENTIAL, GMAIL_DRAFTS_CREDENTIAL],
  // Adapter protocol 2.6: `Messages` and `Labelings` are listenable edges, polled.
  protocolMinor: 6,
  poll: { intervalSeconds: GMAIL_POLL_EVERY_SECONDS },
  create: (ctx) => {
    const client = gmailClientFrom(ctx);
    const adapter = new GmailAdapter({ client, readFile: (ref) => readHandedFile(ctx, ref), log: ctx.log });
    const source = new GmailPollSource(client);
    return Object.assign(adapter, {
      poll: async (input: PollInput | PollEdgeInput) => {
        if (!('edge' in input)) {
          throw new Error('@lf/gmail is listened to on its Messages and Labelings edges: `listen to mail-[m:Messages WHERE m.Labels CONTAINS "INBOX"]-> fire f` (`listen-fire upgrade` rewrites a 0.12 listen)');
        }
        return source.poll(input);
      },
    });
  },
});

export default gmailModule;

export * from './adapter';
export * from './api_client';
export * from './compose';
export * from './credential';
export * from './filter';
export * from './manifest';
export * from './mime';
export * from './poll';
export * from './schema';
export * from './types';
export * from './write';
