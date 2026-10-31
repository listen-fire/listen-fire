// `@lf/system`: the host itself as a source, as a module. It reads the
// host's facts about its runs and waits and turns them into events a
// program listens to (docs/contracts/system-events.md). listen-fire bundles
// it and hands it its facts over the records door (`systemModule`); a host
// that keeps its facts elsewhere (lf-platform) hands them in itself
// (`systemModuleWith`).

import { defineModule, type AdapterModuleDefinition, type ModuleContext, type PollEdgeInput, type PollInput } from 'module-kit';

import { SystemAdapter } from './adapter';
import { SYSTEM_MANIFEST } from './manifest';
import { DEFAULT_POLL_SETTINGS, SYSTEM_POLL_EVERY_SECONDS, pollSystemEvents, type SystemPollSettings } from './poll';
import { recordsOverHostDoor, type SystemRecords } from './records';

/** The operator's settings, from the install's env (`SYSTEM_SETTLE_SECONDS`,
 *  `SYSTEM_PAGE_SIZE`), each a whole number; absent, the defaults. */
export function pollSettingsFrom(env: Readonly<Record<string, string | undefined>>): SystemPollSettings {
  const whole = (name: string, fallback: number, least: number): number => {
    const raw = env[name];
    if (raw === undefined || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < least) throw new Error(`@lf/system: ${name} is "${raw}": a whole number, at least ${least}`);
    return value;
  };
  return { settleSeconds: whole('SYSTEM_SETTLE_SECONDS', DEFAULT_POLL_SETTINGS.settleSeconds, 0), pageSize: whole('SYSTEM_PAGE_SIZE', DEFAULT_POLL_SETTINGS.pageSize, 1) };
}

/** `@lf/system` over the facts `recordsOf` reads for a call's context. */
export function systemModuleWith(recordsOf: (ctx: ModuleContext) => SystemRecords, settings: SystemPollSettings = DEFAULT_POLL_SETTINGS): AdapterModuleDefinition {
  return defineModule({
    kind: 'adapter',
    name: '@lf/system',
    manifest: SYSTEM_MANIFEST,
    // Adapter protocol 2.6: a poll of a listenable edge, and an arrival's
    // `about`, `notFor` and `occurredAt`.
    protocolMinor: 6,
    credentials: [],
    poll: { intervalSeconds: SYSTEM_POLL_EVERY_SECONDS },
    create: (ctx) =>
      Object.assign(new SystemAdapter(), {
        poll: async (input: PollInput | PollEdgeInput) => {
          if (!('edge' in input)) {
            throw new Error('@lf/system is listened to on its Events edge: `listen to sys-[e:Events WHERE e.Kind == "Run Failed"]-> fire f` (`listen-fire upgrade` rewrites a 0.12 listen)');
          }
          return pollSystemEvents(recordsOf(ctx), input, settings);
        },
      }),
  });
}

/** `@lf/system` as listen-fire serves it: its facts from the records door. */
export function systemModule(env: Readonly<Record<string, string | undefined>> = process.env): AdapterModuleDefinition {
  return systemModuleWith(recordsOverHostDoor, pollSettingsFrom(env));
}

export default systemModule();

export * from './adapter';
export * from './handbook_section';
export * from './manifest';
export * from './poll';
export * from './records';
export * from './types';
