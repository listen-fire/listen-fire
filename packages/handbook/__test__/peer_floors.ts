// What a package ships that a core release can break, held to the checker of
// the oldest core its peer range admits. A package's `peerDependencies` on the
// core are wide, so a host on an older core installs it cleanly and meets the
// break only when the programs it ships (the handbook's chapters, a module's
// handbook section) are read by that core's checker.

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';

import { LANGUAGE_VERSION, checkSourceInRust, pluginKey, type CatalogSnapshot } from 'movement-lang';
import { pluginSpecsOf } from 'engine-contracts/plugin_spec';

import { CONTROL_FORMS, CORE_CHAPTERS, controlFormClaims, exampleText, frontEntries, frontPageClaims } from '../index';
import { HANDBOOK_CATALOG, checkExemption } from '../testing';
import { JEV_HANDBOOK_SECTION, JEV_PLUGINS } from '../../../modules/jev';
import { FENCE, MODULES } from './module_manifests';

const REPO = path.resolve(__dirname, '../../..');

/** The packages whose peer range names the core. */
const CORE_PEERS = ['@listen-fire/movement-lang', '@listen-fire/engine', '@listen-fire/engine-contracts'] as const;

export type Triple = readonly [number, number, number];

export function parseVersion(text: string): Triple {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(text);
  if (!m) throw new Error(`not a version: ${text}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: Triple, b: Triple): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

export const formatVersion = (v: Triple): string => v.join('.');

/** The oldest core whose checker can be handed the handbook's catalog. 0.12
 *  refuses a snapshot written in the shape 0.13 introduced (an edge that
 *  announces arrivals), so a program shipped for the current catalog cannot be
 *  checked there at all, and a peer range that admits 0.12 claims what nothing
 *  can hold. */
export const OLDEST_CHECKABLE_CORE: Triple = [0, 13, 0];

/** The oldest core a package's peer range admits: the highest lower bound among
 *  its peers on the core (one core satisfies all of them). Null when it names
 *  no core. */
export function peerFloor(packageJson: { peerDependencies?: Record<string, string> }): Triple | null {
  const bounds = CORE_PEERS.flatMap((peer) => {
    const range = packageJson.peerDependencies?.[peer];
    if (range === undefined) return [];
    const m = /^>=\s*(\d+\.\d+\.\d+)/.exec(range);
    if (!m) throw new Error(`${peer}: peer range "${range}" does not start with a lower bound`);
    return [parseVersion(m[1])];
  });
  return bounds.length === 0 ? null : bounds.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
}

function readPackage(dir: string): { name: string; version: string; peerDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(REPO, dir, 'package.json'), 'utf8'));
}

/** A program a package shows: a whole one (a probe, which a run would check) or
 *  a fragment of one (a fenced example). */
export interface ShippedProgram {
  where: string;
  source: string;
  catalog: CatalogSnapshot;
}

export interface ShippedPackage {
  name: string;
  version: string;
  floor: Triple | null;
  /** The package.json whose peer range to raise. */
  manifestPath: string;
  programs: ShippedProgram[];
}

function fences(content: string, where: string, catalog: CatalogSnapshot): ShippedProgram[] {
  return [...content.matchAll(FENCE)].map((m, i) => ({ where: `${where} #${i + 1}`, source: m[1], catalog }));
}

type Claim = { construct: string; status: string; probe?: string; files?: Readonly<Record<string, string>> };

function probes(claims: readonly Claim[], where: string, catalog: CatalogSnapshot): ShippedProgram[] {
  return claims.flatMap((claim) =>
    claim.status === 'runs' && claim.probe !== undefined && checkExemption({ construct: claim.construct }) === undefined
      ? [
          {
            where: `${where}: ${claim.construct}`,
            source: claim.probe,
            catalog: claim.files
              ? { ...catalog, files: Object.fromEntries(Object.entries(claim.files).map(([file, source]) => [file, { source }])) }
              : catalog,
          },
        ]
      : [],
  );
}

function handbookPackage(): ShippedPackage {
  const catalog = HANDBOOK_CATALOG;
  const chapters = Object.values(CORE_CHAPTERS);
  const programs = [
    ...chapters.flatMap((c) => fences(c.content, `handbook ${c.id}`, catalog)),
    ...chapters.flatMap((c) => probes(c.engineClaims ?? [], `handbook ${c.id}`, catalog)),
    ...frontEntries().flatMap((e) => (e.example ? [{ where: `handbook front#${e.anchor}`, source: exampleText(e.example), catalog }] : [])),
    ...CONTROL_FORMS.map((f) => ({ where: `handbook language search: ${f.name}`, source: exampleText(f.example), catalog })),
    ...probes(frontPageClaims(), 'handbook front page', catalog),
    ...probes(controlFormClaims(), 'handbook language search', catalog),
  ];
  const pkg = readPackage('packages/handbook');
  return { ...pkg, floor: peerFloor(pkg), manifestPath: 'packages/handbook/package.json', programs };
}

function modulePackage(dir: string): ShippedPackage {
  const section = MODULES[dir].handbookSection;
  const pkg = readPackage(`modules/${dir}`);
  return {
    ...pkg,
    floor: peerFloor(pkg),
    manifestPath: `modules/${dir}/package.json`,
    programs: section ? [...fences(section.content, `${pkg.name} section`, HANDBOOK_CATALOG), ...probes(section.engineClaims ?? [], `${pkg.name} section`, HANDBOOK_CATALOG)] : [],
  };
}

/** `@lf/jev` adds a plugin section, not a system one: its programs are checked
 *  against the handbook's catalog with its plugins added. */
function jevPackage(): ShippedPackage {
  const plugin = '@lf/jev';
  const catalog: CatalogSnapshot = {
    ...HANDBOOK_CATALOG,
    plugins: {
      ...HANDBOOK_CATALOG.plugins,
      ...Object.fromEntries(Object.entries(pluginSpecsOf(JEV_PLUGINS)).map(([name, spec]) => [pluginKey(plugin, name), { ...spec, package: plugin, name }])),
    },
  };
  const pkg = readPackage('modules/jev');
  return {
    ...pkg,
    floor: peerFloor(pkg),
    manifestPath: 'modules/jev/package.json',
    programs: [...fences(JEV_HANDBOOK_SECTION.content, `${pkg.name} section`, catalog), ...probes(JEV_HANDBOOK_SECTION.engineClaims ?? [], `${pkg.name} section`, catalog)],
  };
}

/** Every package that ships programs, with them. */
export function shippedPackages(): ShippedPackage[] {
  return [handbookPackage(), ...Object.keys(MODULES).map(modulePackage), jevPackage()];
}

// ── The core a floor names ─────────────────────────────────────────────────

interface CoreChecker {
  version: string;
  /** The diagnostics at error severity, or the refusal as one entry (the
   *  program does not parse, or the snapshot does not load). */
  errors(program: ShippedProgram): string[];
}

const errorsOf = (run: () => Array<{ code: string; message: string; severity?: string }>): string[] => {
  try {
    return run()
      .filter((d) => (d.severity ?? 'error') === 'error')
      .map((d) => `${d.code}: ${d.message}`);
  } catch (error) {
    return [`REFUSED: ${error instanceof Error ? error.message : String(error)}`];
  }
};

/** The release `version` from npm, installed once into a cache the checkout
 *  keeps (`node_modules/.cache`). */
function installDirOf(version: string): string {
  const dir = path.join(REPO, 'node_modules/.cache/peer-floors', version);
  if (existsSync(path.join(dir, 'node_modules/@listen-fire/movement-lang/package.json'))) return dir;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `core-${version}`, private: true }));
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock', `@listen-fire/movement-lang@${version}`], {
    cwd: dir,
    stdio: 'pipe',
    timeout: 240_000,
  });
  return dir;
}

/** The catalog as the older checker could have been given it: no member the
 *  release did not define. */
function catalogFor(version: Triple, catalog: CatalogSnapshot): CatalogSnapshot {
  // `AdapterSpec.package` and a plugin's came with 0.13.1; a reader built before it refuses a snapshot carrying it.
  if (compareVersions(version, [0, 13, 1]) >= 0) return catalog;
  const stripped = JSON.parse(JSON.stringify(catalog)) as { adapters?: Record<string, Record<string, unknown>>; plugins?: Record<string, Record<string, unknown>> };
  for (const adapter of Object.values(stripped.adapters ?? {})) delete adapter.package;
  return stripped as unknown as CatalogSnapshot;
}

/** The checker of release `version`: the workspace's own when the floor is the
 *  release being written, else that release from npm. */
export function coreChecker(version: Triple): CoreChecker {
  const text = formatVersion(version);
  if (compareVersions(version, parseVersion(LANGUAGE_VERSION)) >= 0) {
    return { version: text, errors: (p) => errorsOf(() => checkSourceInRust(p.source, p.catalog, { languageVersion: LANGUAGE_VERSION })) };
  }
  // The release's own copy, by path: never the workspace's.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const lang = require(path.join(installDirOf(text), 'node_modules/@listen-fire/movement-lang'));
  return {
    version: text,
    errors: (p) => errorsOf(() => lang.checkSourceInRust(p.source, catalogFor(version, p.catalog), { languageVersion: lang.LANGUAGE_VERSION })),
  };
}

/** What `core` reports of `program` that the workspace's checker does not: an
 *  error the program draws only there. A fragment of a program draws the same
 *  unresolved names under both, so only the difference is a break. */
export function breaksUnder(core: CoreChecker, program: ShippedProgram): string[] {
  const current = errorsOf(() => checkSourceInRust(program.source, program.catalog, { languageVersion: LANGUAGE_VERSION }));
  const code = (entry: string) => entry.slice(0, entry.indexOf(':'));
  const remaining = current.map(code);
  return core.errors(program).filter((entry) => {
    const at = remaining.indexOf(code(entry));
    if (at === -1) return true;
    remaining.splice(at, 1);
    return false;
  });
}
