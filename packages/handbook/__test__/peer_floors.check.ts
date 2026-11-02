// A package's peer range on the core says which cores it works with. What a
// package ships that a core reads (the handbook's chapters, a module's handbook
// section) must check under the OLDEST core the range admits, or a host on that
// core installs the package cleanly and then fails on its content. Each
// package's programs are checked by that release's checker, installed from npm
// into node_modules/.cache (the first run needs the network). Run by
// scripts/release/check-peer-floors.mjs, not by the handbook's unit tests,
// which run offline.
//
// A failure here means the package now teaches something an older core does not
// read: raise its peer floor on the core packages (`peerDependencies` of
// movement-lang, engine and engine-contracts) to the release that reads it, in
// its own changeset (RELEASING.md).

import { OLDEST_CHECKABLE_CORE, breaksUnder, compareVersions, coreChecker, formatVersion, shippedPackages, type ShippedProgram } from './peer_floors';
import { HANDBOOK_CATALOG } from '../testing';

jest.setTimeout(300_000);

const packages = shippedPackages();
const withFloor = packages.filter((p) => p.floor !== null);

describe('the programs a package ships check under the oldest core its peer range admits', () => {
  it('are there to check', () => {
    expect(packages.length).toBeGreaterThanOrEqual(15);
    expect(packages.every((p) => p.programs.length > 0)).toBe(true);
    expect(withFloor.length).toBe(packages.length);
  });

  it.each(withFloor.map((p) => [p.name, p] as const))('%s', (_name, pkg) => {
    const floor = pkg.floor;
    if (floor === null) return;
    if (compareVersions(floor, OLDEST_CHECKABLE_CORE) < 0) {
      throw new Error(
        `${pkg.manifestPath} admits core ${formatVersion(floor)}, whose checker cannot read the catalog its programs are checked against: raise the floor to >=${formatVersion(OLDEST_CHECKABLE_CORE)}.`,
      );
    }
    const core = coreChecker(floor);
    const broken = pkg.programs.flatMap((program) => {
      const breaks = breaksUnder(core, program);
      return breaks.length > 0 ? [`${program.where}\n    ${breaks.join('\n    ')}`] : [];
    });
    if (broken.length > 0) {
      throw new Error(
        `${pkg.name} admits core ${core.version} (${pkg.manifestPath}), which does not read ${broken.length} of the programs it ships. Raise its core peer floor to the release that does, in its own changeset.\n  ${broken.join('\n  ')}`,
      );
    }
  });
});

describe('the check itself', () => {
  const program = (source: string): ShippedProgram => ({ where: 'probe', source, catalog: HANDBOOK_CATALOG });

  it('finds a program an older core does not read, and one it does', () => {
    expect(breaksUnder(coreChecker([0, 13, 1]), program('m = { A: 1 }\nx = m?.A\n')).join()).toMatch(/MOV_EXPR_PARSE/);
    expect(breaksUnder(coreChecker([0, 13, 1]), program('m = { A: 1 }\nx = m.A\n'))).toEqual([]);
  });

  it('holds a connect with no import to 0.13.1, which introduced it', () => {
    const connected = program('sys = connect `@lf/system`\n\nfunction f(e: <sys-[:Events]->>) { return e.Reason }');
    expect(breaksUnder(coreChecker([0, 13, 0]), connected)).not.toEqual([]);
    expect(breaksUnder(coreChecker([0, 13, 1]), connected)).toEqual([]);
  });
});
