// `@lf/jev`: Jev (Typesafe AI's non-generative judge) as two cheap classifier
// plugins. A movement imports the package
// (``import { `@lf/jev` as jev } from plugins``) and calls
// `jev.score(subject, question)` for how likely a statement is true, or
// `jev.classify(subject, labels, question)` for which label fits.
//
// Each call is priced: it answers what it cost, which counts against the
// run's cost cap the way a model call does, and a priced plugin is not
// started once the run has spent its cap. The credential is an API key and,
// optionally, the address of another Jev.

import type { PluginModuleDefinition } from 'module-kit';
import type { WireCredentialDeclarationShape } from 'engine-contracts';

import { defineModule } from 'module-kit';
import { pluginProgramName } from 'engine-contracts/plugin_spec';

import { endpointOf } from './client';
import { CLASSIFY_PLUGIN, JEV_PLUGINS, SCORE_PLUGIN, classify, score } from './plugins';

export const JEV_CREDENTIAL: WireCredentialDeclarationShape = {
  name: 'jev',
  kind: 'static',
  fields: [
    { name: 'apiKey', label: 'Jev API key' },
    { name: 'baseUrl', label: 'Jev API address (leave empty for https://api.typesafe.ai/v1)', secret: false, optional: true },
  ],
};

const BODIES = {
  [pluginProgramName(SCORE_PLUGIN.signature.name)]: score,
  [pluginProgramName(CLASSIFY_PLUGIN.signature.name)]: classify,
};

/** The module, with how long its first retry may wait (tests shorten it). */
export function jevModuleWith(options: { retryDelayMs?: number } = {}): PluginModuleDefinition {
  return defineModule({
    kind: 'plugin',
    name: '@lf/jev',
    credentials: [JEV_CREDENTIAL],
    plugins: JEV_PLUGINS,
    create: (ctx) => ({
      async invokePlugin({ name, config }) {
        const body = BODIES[pluginProgramName(name)];
        if (body === undefined) throw new Error(`@lf/jev has no plugin "${name}"`);
        const endpoint = endpointOf(await ctx.credential.fields().catch(() => ({})));
        return body(config, { endpoint, fetch: ctx.fetch, retryDelayMs: options.retryDelayMs });
      },
    }),
  });
}

export const jevModule = jevModuleWith();

export default jevModule;

export { JEV_PLUGINS, SCORE_PLUGIN, CLASSIFY_PLUGIN } from './plugins';
export { JEV_HANDBOOK_SECTION } from './handbook_section';
export { DEFAULT_JEV_BASE_URL, JEV_MAX_INPUT_TOKENS, JEV_PRICE_PER_MILLION_INPUT_TOKENS } from './client';
