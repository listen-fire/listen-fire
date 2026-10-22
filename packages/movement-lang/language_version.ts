// The language version is the toolchain release: the one semver every crate
// and package carries. A movement's pin is the release it was written
// against, and a release reads a pin whose compatibility key is its own: the
// minor under 0.x (`0.12`), the major from 1.0 (`1`). Any other pin is refused
// by name, with the remedy (docs/contracts/language-versions.md).
//
// The same rule is crates/movement-parser/src/version.rs; a test holds the two
// equal (packages/engine-contracts/__test__/contracts.unit.test.ts).

import type { Diagnostic } from './checker/diagnostic';
import { PACKAGE_VERSION } from './language_version_value';
import { neverAsAny } from './never';

/** A pin: the release a movement was written against, `MAJOR.MINOR.PATCH[-pre]`. */
export type LanguageVersion = string;

/** This release's version, and so the language it reads. */
export const LANGUAGE_VERSION: LanguageVersion = PACKAGE_VERSION;

export type LanguageVersionStanding = 'compatible' | 'newer' | 'olderKey' | 'malformed';

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parse(version: string): { major: number; minor: number } | undefined {
  const match = SEMVER.exec(version);
  return match === null ? undefined : { major: Number(match[1]), minor: Number(match[2]) };
}

/** The part of a version a pin must share with a release; undefined for a
 *  text that is not a version. */
export function compatibilityKey(version: string): string | undefined {
  const parsed = parse(version);
  if (parsed === undefined) return undefined;
  return parsed.major === 0 ? `0.${parsed.minor}` : String(parsed.major);
}

/** How `pin` stands against the release `own`. */
export function languageVersionStanding(pin: string, own: LanguageVersion = LANGUAGE_VERSION): LanguageVersionStanding {
  const pinned = parse(pin);
  const release = parse(own);
  if (pinned === undefined || release === undefined) return 'malformed';
  if (compatibilityKey(pin) === compatibilityKey(own)) return 'compatible';
  const newer = pinned.major !== release.major ? pinned.major > release.major : pinned.minor > release.minor;
  return newer ? 'newer' : 'olderKey';
}

/** Whether the release `own` reads a movement pinned to `pin`. */
export function compatible(pin: string, own: LanguageVersion = LANGUAGE_VERSION): boolean {
  return languageVersionStanding(pin, own) === 'compatible';
}

export const LanguageVersionDiagnosticCodes = {
  UNSUPPORTED: 'MOV_LANGUAGE_VERSION_UNSUPPORTED',
} as const;

function refusalMessage(pin: string, own: string, standing: Exclude<LanguageVersionStanding, 'compatible'>): string {
  switch (standing) {
    case 'newer':
      return `this automation pins language ${pin}, newer than this release (${own}); upgrade the engine`;
    case 'olderKey':
      return `this automation pins language ${pin}, which this release (${own}) does not read; validate it under ${own} and upgrade it`;
    case 'malformed':
      return `this automation pins language ${pin}, which is not a version; a pin is a release's version, such as ${own}`;
    default:
      return neverAsAny(standing);
  }
}

/**
 * What a movement pinned to `pin` must be told before anything else: an error
 * when this release does not read it (never a silent fallback to the current
 * version), naming the pin and the remedy; nothing when it does.
 */
export function languageVersionDiagnostic(pin: string, own: LanguageVersion = LANGUAGE_VERSION): Diagnostic | undefined {
  const standing = languageVersionStanding(pin, own);
  if (standing === 'compatible') return undefined;
  return {
    code: LanguageVersionDiagnosticCodes.UNSUPPORTED,
    message: refusalMessage(pin, own, standing),
    span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
  };
}

/** The run host's units (Henry 2026-10-16): every file has these names in
 *  scope, each already connected — `listen to manual fire hello`,
 *  `listen to cron { schedule: "0 9 * * 1" } fire digest` — with no import
 *  and no `connect`. A file's own binding of the name replaces it.
 *  (`RUN_HOST_UNITS` in crates/movement-parser/src/version.rs.) */
export const RUN_HOST_UNITS: readonly string[] = ['cron', 'manual'];
