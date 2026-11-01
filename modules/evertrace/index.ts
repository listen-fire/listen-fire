// `@lf/evertrace`: Evertrace as a module. The host hands it the install's
// credential (an API key, and optionally a base URL) and a fetch; the module
// builds a client per call from them, so a credential edited between calls is
// read by the next one. `ctx.config.baseUrlOverride` (the dev loop's fake)
// wins over the credential's own base URL.

import { defineModule, type CredentialFields, type ModuleContext, type PollEdgeInput, type PollInput } from 'module-kit';

import { EvertraceApiClient, evertraceCredsParser } from './api_client';
import { EvertraceAdapter, type EvertraceClientSource } from './adapter';
import { EVERTRACE_MANIFEST } from './manifest';
import { pollEvertrace } from './poll';
import { EVERTRACE_POLL_EVERY_SECONDS } from './types';

/** The client the context's credential reaches Evertrace with. */
export function evertraceClientFrom(ctx: ModuleContext): EvertraceClientSource {
  // The client for the fields last read: a host hands back the same fields
  // until the credential changes, so one client serves until then.
  let last: { fields: CredentialFields; client: EvertraceApiClient } | undefined;
  return async () => {
    const fields = await ctx.credential.fields();
    if (last?.fields === fields) return last.client;
    const parsed = evertraceCredsParser.safeParse(fields);
    if (!parsed.success) {
      throw new Error('Evertrace: the connected credential holds no API key. Connect Evertrace.');
    }
    const baseUrl = ctx.config.baseUrlOverride ?? parsed.data.baseUrl;
    const client = new EvertraceApiClient({
      apiKey: parsed.data.apiKey,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      fetch: ctx.fetch,
      log: ctx.log,
    });
    last = { fields, client };
    return client;
  };
}

export const evertraceModule = defineModule({
  kind: 'adapter',
  name: '@lf/evertrace',
  manifest: EVERTRACE_MANIFEST,
  // The stored payload the connect form writes: `{ apiKey, baseUrl? }`.
  credentials: [
    {
      name: 'evertrace',
      kind: 'static',
      fields: [
        { name: 'apiKey', label: 'API key' },
        { name: 'baseUrl', label: 'Base URL', secret: false, optional: true },
      ],
    },
  ],
  // Adapter protocol 2.6: `Signals` and `List Entries` are listenable edges, polled.
  protocolMinor: 6,
  poll: { intervalSeconds: EVERTRACE_POLL_EVERY_SECONDS },
  create: (ctx) => {
    const client = evertraceClientFrom(ctx);
    return Object.assign(new EvertraceAdapter(client), {
      poll: async (input: PollInput | PollEdgeInput) => {
        if (!('edge' in input)) {
          throw new Error('@lf/evertrace is listened to on its Signals and List Entries edges: `listen to evertrace-[s:Signals]-> fire f` (`listen-fire upgrade` rewrites a 0.12 listen)');
        }
        return pollEvertrace(await client(), input, { log: ctx.log });
      },
    });
  },
});

export default evertraceModule;

export * from './adapter';
export * from './api_client';
export * from './filter';
export * from './manifest';
export * from './poll';
export * from './saved_search';
export * from './schema';
export * from './types';
export * from './write';
