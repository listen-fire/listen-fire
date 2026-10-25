// The integer contracts' versions, as one table. Each is an integer the contract's
// doc under docs/contracts/ states, and a test holds each constant here equal
// to its doc and the table equal to docs/contracts/README.md.
//
// The rule mirrors the language's: an additive change a reader can ignore
// keeps the version; a change in meaning bumps it, and the reader branches on
// the version at the point of difference, never by a forked reader. A version
// this release does not support is refused at the boundary, loudly.

import {
  CATALOG_SNAPSHOT_VERSION,
  DEPRECATED_CATALOG_SNAPSHOT_VERSIONS,
  LANGUAGE_VERSION,
  STORY_ANALYSIS_VERSION,
  SUPPORTED_CATALOG_SNAPSHOT_VERSIONS,
  SUPPORTED_STORY_ANALYSIS_VERSIONS,
  compatibilityKey,
} from 'movement-lang';

import { MANIFEST_PROTOCOL_VERSION, PROTOCOL_MINOR } from './protocol';

// The snapshot is the language's type, so its version lives beside it.
export { CATALOG_SNAPSHOT_VERSION, DEPRECATED_CATALOG_SNAPSHOT_VERSIONS, SUPPORTED_CATALOG_SNAPSHOT_VERSIONS };

// The story analysis is the checker's output, so its version lives beside it too.
export { STORY_ANALYSIS_VERSION, SUPPORTED_STORY_ANALYSIS_VERSIONS };

/** A parked flow's state (docs/contracts/park-state.md). Engine to engine: a
 *  host stores it and hands it back. Version 2 is the Rust engine's; the earlier
 *  TypeScript engine wrote and read 1. */
export const PARK_STATE_VERSION = 2;

/** The park state versions this release reads: each engine its own. */
export const SUPPORTED_PARK_STATE_VERSIONS: ReadonlySet<number> = new Set([1, 2]);

/** The host families and the entry points (docs/contracts/host-families.md),
 *  carried on every `segment.open`. */
export const HOST_FAMILIES_VERSION = 1;

/** The host families versions this release serves. */
export const SUPPORTED_HOST_FAMILIES_VERSIONS: ReadonlySet<number> = new Set([1]);

/** What a system caller verifier sees and answers (docs/contracts/system-caller.md):
 *  the in-process interface a host's system endpoints authenticate through. */
export const SYSTEM_CALLER_VERSION = 1;

export interface ContractStanding {
  current: number;
  supported: readonly number[];
  deprecated: readonly number[];
  /** The highest minor of `current` this release speaks, for a contract
   *  versioned 2.N (the adapter protocol): it reads every minor from 0 up. */
  minor?: number;
}

/** What this release speaks, contract by contract: the index
 *  docs/contracts/README.md tabulates. */
export const CONTRACTS = {
  'catalog-snapshot': {
    current: CATALOG_SNAPSHOT_VERSION,
    supported: [...SUPPORTED_CATALOG_SNAPSHOT_VERSIONS],
    deprecated: [...DEPRECATED_CATALOG_SNAPSHOT_VERSIONS],
  },
  'park-state': { current: PARK_STATE_VERSION, supported: [...SUPPORTED_PARK_STATE_VERSIONS], deprecated: [] },
  'host-families': {
    current: HOST_FAMILIES_VERSION,
    supported: [...SUPPORTED_HOST_FAMILIES_VERSIONS],
    deprecated: [],
  },
  'adapter-protocol': { current: MANIFEST_PROTOCOL_VERSION, supported: [MANIFEST_PROTOCOL_VERSION], deprecated: [], minor: PROTOCOL_MINOR },
  'system-caller': { current: SYSTEM_CALLER_VERSION, supported: [SYSTEM_CALLER_VERSION], deprecated: [] },
  // The shape of what the check settled, for a surface that draws a movement's story (docs/contracts/story-analysis.md).
  'story-analysis': { current: STORY_ANALYSIS_VERSION, supported: [...SUPPORTED_STORY_ANALYSIS_VERSIONS], deprecated: [] },
} as const satisfies Record<string, ContractStanding>;

/** The language's contract (docs/contracts/language-versions.md) is not an
 *  integer of its own: it is the release's version, and a release reads the
 *  pins that share its compatibility key. */
export const LANGUAGE_CONTRACT = {
  version: LANGUAGE_VERSION,
  key: compatibilityKey(LANGUAGE_VERSION),
} as const;

/** Refuse a `segment.open` whose host families version this host does not
 *  serve: it names the contract, the version it was handed and the ones it
 *  serves. An opening that names no version is refused the same way. */
export function refuseUnsupportedHostFamiliesVersion(opening: { hostFamiliesVersion?: unknown }): void {
  const seen = opening.hostFamiliesVersion;
  if (typeof seen === 'number' && SUPPORTED_HOST_FAMILIES_VERSIONS.has(seen)) return;
  throw new Error(
    `segment.open carries host families version ${JSON.stringify(seen) ?? 'none'}, which this host does not serve ` +
      `(supported: ${[...SUPPORTED_HOST_FAMILIES_VERSIONS].join(', ')})`,
  );
}

/** Refuse a parked state whose version this release does not read, before
 *  anything is rehydrated from it: it names the contract, the version it was
 *  handed and the ones it reads. Every writer has always stamped the version,
 *  so a state that names none is refused the same way. */
export function refuseUnsupportedParkStateVersion(version: unknown): void {
  if (typeof version === 'number' && SUPPORTED_PARK_STATE_VERSIONS.has(version)) return;
  throw new Error(
    `the parked state carries park state version ${JSON.stringify(version) ?? 'none'}, which this release does not read ` +
      `(supported: ${[...SUPPORTED_PARK_STATE_VERSIONS].join(', ')})`,
  );
}
