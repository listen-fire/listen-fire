// `@lf/forms`: a form at a link, answered once. `listen-fire connect @lf/forms`
// installs it; it needs no credential. A form's link is its install's door
// under `listen-fire serve`, so lf.yaml's `publicUrl` says where people reach it.

import { defineModule, type ModuleContext } from 'module-kit';

import { FormsAdapter, newFormId, type FormsSources } from './adapter';
import { FORMS_MANIFEST } from './manifest';

/** The adapter's sources over a module context: the install's kv and door. */
export function formsSourcesFrom(ctx: ModuleContext): FormsSources {
  return { kv: ctx.kv, inboundUrl: ctx.config.inboundUrl, newId: newFormId };
}

export const formsModule = defineModule({
  kind: 'adapter',
  name: '@lf/forms',
  manifest: FORMS_MANIFEST,
  // Adapter protocol 2.6: an answer arrives with the request that posts it
  // (`arrivals`, 2.5), and the kept request holds the headers
  // `captureHeaders` names (2.6), which an older host would not honour.
  protocolMinor: 6,
  credentials: [],
  // The module checks every request itself; nothing is signed, since the
  // form's unguessable id is what guards it.
  // A form post is read as a form or as JSON by its content type, replayed too.
  inbound: { providerKey: 'forms', scheme: 'module', secretIssuedBy: 'provider', captureHeaders: ['content-type'] },
  create: (ctx) => new FormsAdapter(formsSourcesFrom(ctx)),
});

export default formsModule;

export * from './adapter';
export * from './fields';
export * from './manifest';
export * from './page';
