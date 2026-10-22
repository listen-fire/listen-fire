import fs from 'fs';
import path from 'path';

import { LANGUAGE_VERSION, compatibilityKey, languageVersionDiagnostic, languageVersionStanding } from 'movement-lang';

import {
  CATALOG_SNAPSHOT_VERSION,
  CONTRACTS,
  CORE_PARK_REASONS,
  LANGUAGE_CONTRACT,
  HOST_FAMILIES,
  HOST_FAMILIES_VERSION,
  MANIFEST_PROTOCOL_VERSION,
  PARK_STATE_VERSION,
  PROTOCOL_VERSION,
  SYSTEM_CALLER_VERSION,
  hostMethodPaths,
  isCorePark,
  refuseUnsupportedHostFamiliesVersion,
  refuseUnsupportedParkStateVersion,
  tenantIdOf,
} from '../index';

describe('the tenant id', () => {
  it('brands any non-empty string, which it carries unchanged', () => {
    expect(tenantIdOf('a-tenant')).toBe('a-tenant');
  });

  it('refuses the empty string, which names no tenant', () => {
    expect(() => tenantIdOf('')).toThrow();
  });
});

describe('park reasons', () => {
  it('owns a timer, an await and a limit, and treats any other reason as a unit\'s', () => {
    expect([...CORE_PARK_REASONS]).toEqual(['timer', 'await', 'limit']);
    expect(CORE_PARK_REASONS.every(isCorePark)).toBe(true);
    expect(isCorePark('ask')).toBe(false);
  });
});

describe('the host families manifest', () => {
  it('names each method once, by its path', () => {
    const paths = hostMethodPaths();
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain('park.sink.commitAwaitPark');
    expect(Object.keys(HOST_FAMILIES)).toContain('segment');
  });
});

describe('the contract versions are the ones docs/contracts/ states', () => {
  const docs = path.resolve(__dirname, '../../../docs/contracts');
  const read = (file: string) => fs.readFileSync(path.join(docs, file), 'utf8');
  const versionLine = (file: string) => {
    const match = /^Version: (\d+)$/m.exec(read(file));
    if (match === null) throw new Error(`${file} has no "Version: N" line`);
    return Number(match[1]);
  };
  const versionList = (cell: string) => (cell === 'none' ? [] : cell.split(', ').map(Number));

  it('each document states its constant', () => {
    expect(versionLine('catalog-snapshot.md')).toBe(CATALOG_SNAPSHOT_VERSION);
    expect(versionLine('park-state.md')).toBe(PARK_STATE_VERSION);
    expect(versionLine('host-families.md')).toBe(HOST_FAMILIES_VERSION);
    expect(versionLine('adapter-protocol.md')).toBe(MANIFEST_PROTOCOL_VERSION);
    expect(String(versionLine('adapter-protocol.md'))).toBe(PROTOCOL_VERSION);
    expect(versionLine('system-caller.md')).toBe(SYSTEM_CALLER_VERSION);
  });

  it('the index is the CONTRACTS table, contract by contract', () => {
    const rows = [...read('README.md').matchAll(/^\| ([a-z-]+) \| \[[^\]]+\]\(([^)]+)\) \| (\d+) \| ([^|]+) \| ([^|]+) \|/gm)];
    const indexed = Object.fromEntries(
      rows.map(([, name, file, current, supported, deprecated]) => {
        expect(file).toBe(`${name}.md`);
        return [name, { current: Number(current), supported: versionList(supported.trim()), deprecated: versionList(deprecated.trim()) }];
      }),
    );
    expect(indexed).toEqual(CONTRACTS);
  });

  it('the language row states the release\'s compatibility key', () => {
    const row = /^\| language-versions \| \[language-versions\.md\]\(language-versions\.md\) \| the release \| the release's compatibility key \(([^)]+)\) \|/m.exec(read('README.md'));
    if (row === null) throw new Error('README.md no longer spells the language row as this test reads it');
    expect(row[1]).toBe(LANGUAGE_CONTRACT.key);
    expect(LANGUAGE_CONTRACT).toEqual({ version: LANGUAGE_VERSION, key: compatibilityKey(LANGUAGE_VERSION) });
  });
});

// The compatibility rule is one rule in two implementations, both held to
// docs/contracts/language-versions.md: its table of standings runs through the
// TypeScript, and its three refusals are the Rust's words and the TypeScript's.
// TODO(PLAN-04 Task 2): run the table through the wasm's `language_standing`
// entry too, for a true two-implementation run, instead of reading the Rust
// source's message constants.
describe('the language versions document is the rule both implementations apply', () => {
  const docs = path.resolve(__dirname, '../../../docs/contracts');
  const doc = fs.readFileSync(path.join(docs, 'language-versions.md'), 'utf8');
  const rust = fs.readFileSync(path.resolve(__dirname, '../../../crates/movement-parser/src/version.rs'), 'utf8');
  const STANDING_OF_ROW = { compatible: 'compatible', newer: 'newer', 'older key': 'olderKey', malformed: 'malformed' } as const;
  const rows = [...doc.matchAll(/^\| ([^ |]+) \| ([^ |]+) \| (compatible|newer|older key|malformed) \|$/gm)].map(
    ([, pin, own, standing]) => ({ pin, own, standing: STANDING_OF_ROW[standing as keyof typeof STANDING_OF_ROW] }),
  );

  it('tabulates every standing', () => {
    expect(new Set(rows.map((row) => row.standing))).toEqual(new Set(Object.values(STANDING_OF_ROW)));
  });

  it('the TypeScript reads each pin as the document does', () => {
    for (const { pin, own, standing } of rows) expect({ pin, own, standing: languageVersionStanding(pin, own) }).toEqual({ pin, own, standing });
  });

  it('the three refusals are the document\'s, the Rust\'s and the TypeScript\'s', () => {
    const quoted = (label: string) => {
      const match = new RegExp(`^- \\*\\*${label}:\\*\\* "([^"]+)"$`, 'm').exec(doc);
      if (match === null) throw new Error(`language-versions.md no longer quotes the ${label} refusal as this test reads it`);
      return match[1];
    };
    const constant = (name: string) => {
      const match = new RegExp(`^const ${name}: &str =\\s*"([^"]+)";$`, 'm').exec(rust);
      if (match === null) throw new Error(`version.rs no longer spells ${name} as this test reads it`);
      return match[1];
    };
    const fill = (template: string, pin: string, own: string) => template.replaceAll('{pin}', pin).replaceAll('{own}', own);
    const cases = [
      { label: 'newer', name: 'NEWER_MESSAGE', pin: '0.13.0' },
      { label: 'older key', name: 'OLDER_KEY_MESSAGE', pin: '0.11.0' },
      { label: 'malformed', name: 'MALFORMED_MESSAGE', pin: 'banana' },
    ];
    for (const { label, name, pin } of cases) {
      expect(constant(name)).toBe(quoted(label));
      expect(languageVersionDiagnostic(pin, '0.12.0')).toEqual({
        code: 'MOV_LANGUAGE_VERSION_UNSUPPORTED',
        message: fill(quoted(label), pin, '0.12.0'),
        span: { start: { line: 1, col: 1 }, end: { line: 1, col: 1 } },
      });
    }
  });

  it('the Rust reads this release\'s version from its crate, the TypeScript from its package', () => {
    expect(rust).toMatch(/^pub const LANGUAGE_VERSION: &str = env!\("CARGO_PKG_VERSION"\);$/m);
    const cargo = fs.readFileSync(path.resolve(__dirname, '../../../Cargo.toml'), 'utf8');
    const workspaceVersion = /^version = "([^"]+)"$/m.exec(cargo);
    expect(workspaceVersion?.[1]).toBe(LANGUAGE_VERSION);
  });
});

describe('a host families version is refused at segment.open unless this host serves it', () => {
  it('passes the version it serves', () => {
    expect(() => refuseUnsupportedHostFamiliesVersion({ hostFamiliesVersion: HOST_FAMILIES_VERSION })).not.toThrow();
  });

  it('refuses another version, or none, naming the contract, what it saw and what it serves', () => {
    expect(() => refuseUnsupportedHostFamiliesVersion({ hostFamiliesVersion: 9 })).toThrow(
      'segment.open carries host families version 9, which this host does not serve (supported: 1)',
    );
    expect(() => refuseUnsupportedHostFamiliesVersion({})).toThrow(
      'segment.open carries host families version none, which this host does not serve (supported: 1)',
    );
  });
});

describe('a park state version is refused on read unless this release reads it', () => {
  it('passes the versions it reads: 1 (the TypeScript engine) and 2 (the Rust engine)', () => {
    expect(() => refuseUnsupportedParkStateVersion(PARK_STATE_VERSION)).not.toThrow();
    expect(() => refuseUnsupportedParkStateVersion(1)).not.toThrow();
  });

  it('refuses another version, or none, naming the contract, what it saw and what it reads', () => {
    expect(() => refuseUnsupportedParkStateVersion(3)).toThrow(
      'the parked state carries park state version 3, which this release does not read (supported: 1, 2)',
    );
    expect(() => refuseUnsupportedParkStateVersion(undefined)).toThrow(
      'the parked state carries park state version none, which this release does not read (supported: 1, 2)',
    );
  });
});

// The Rust engine's own input (`SegmentInput`, crates/movement-engine/src/
// run.rs), read from its source as the version table is: the README's
// `engine_start` member list names every field, optional ones marked `?`,
// and host-families.md's "Inputs only the Rust engine takes" names every
// field the shim reads from its process or deployment (a field whose doc
// says "so the engine reads no environment").
describe("the Rust engine's segment input is the one its documents name", () => {
  const repo = path.resolve(__dirname, '../../..');
  const source = fs.readFileSync(path.join(repo, 'crates/movement-engine/src/run.rs'), 'utf8');
  const struct = /^pub struct SegmentInput \{\n([\s\S]*?)^\}/m.exec(source);
  if (struct === null) throw new Error('run.rs no longer spells SegmentInput as this test reads it');
  const camel = (name: string) => name.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  const fields: Array<{ name: string; optional: boolean; fromEnvironment: boolean }> = [];
  let preamble: string[] = [];
  for (const line of struct[1].split('\n')) {
    const field = /^ {4}pub (\w+): (.+),$/.exec(line.trimEnd());
    if (field === null) {
      preamble.push(line);
      continue;
    }
    const attributes = preamble.join('\n');
    fields.push({
      name: camel(field[1]),
      optional: field[2].startsWith('Option<') || /#\[serde\(default/.test(attributes),
      fromEnvironment: /so the engine reads no\s+(?:\/\/\/\s+)?environment/.test(attributes),
    });
    preamble = [];
  }

  it('the README lists every field, its optional ones marked', () => {
    const readme = fs.readFileSync(path.join(repo, 'crates/movement-engine/README.md'), 'utf8');
    const list = /\*\*The input\*\* \(`engine_start`\): `\{([^}]*)\}`/.exec(readme);
    if (list === null) throw new Error('the README no longer spells the engine_start input as this test reads it');
    const listed = list[1].split(',').map((member) => member.trim().split(':')[0]!.trim());
    expect(listed).toEqual(['entry', ...fields.map(({ name, optional }) => (optional ? `${name}?` : name))]);
  });

  it("host-families.md names each input the shim reads so the engine reads no environment", () => {
    const doc = fs.readFileSync(path.join(repo, 'docs/contracts/host-families.md'), 'utf8');
    const section = /^- \*\*Inputs only the Rust engine takes\.\*\*[^\n]*\n((?: {2}- [^\n]*\n)+)/m.exec(doc);
    if (section === null) throw new Error('host-families.md no longer spells the inputs only the Rust engine takes as this test reads them');
    const named = [...section[1].matchAll(/^ {2}- `(\w+)`:/gm)].map(([, name]) => name);
    expect(named).toEqual(fields.filter((f) => f.fromEnvironment).map((f) => f.name));
  });
});
