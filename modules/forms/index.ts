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
  // Adapter protocol 2.5: an answer arrives with the request that posts it
  // (`arrivals`), which an older host would drop.
  protocolMinor: 5,
  credentials: [],
  // The module checks every request itself; nothing is signed, since the
  // form's unguessable id is what guards it.
  inbound: { providerKey: 'forms', scheme: 'module', secretIssuedBy: 'provider' },
  create: (ctx) => new FormsAdapter(formsSourcesFrom(ctx)),
});

export default formsModule;

export * from './adapter';
export * from './fields';
export * from './manifest';
export * from './page';
