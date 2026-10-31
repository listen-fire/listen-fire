import fs from 'fs';
import path from 'path';

import { LANGUAGE_VERSION, compatibilityKey, languageStanding, languageVersionDiagnostic, languageVersionStanding } from 'movement-lang';

import {
  CATALOG_SNAPSHOT_VERSION,
  CONTRACTS,
  ADAPTER_METHODS,
  AdapterWakeBody,
  CORE_PARK_REASONS,
  LANGUAGE_CONTRACT,
  HOST_FAMILIES,
  HOST_FAMILIES_VERSION,
  HostModelRequest,
  MANIFEST_PROTOCOL_VERSION,
  PARK_STATE_VERSION,
  PROTOCOL_MINOR,
  PROTOCOL_VERSION,
  STORY_ANALYSIS_VERSION,
  SYSTEM_CALLER_VERSION,
  hostMethodPaths,
  isCorePark,
  missingHostMethods,
  refuseUnsupportedHostFamiliesVersion,
  refuseUnsupportedParkStateVersion,
  tenantIdOf,
} from '../index';
import { ModelsCallRequest } from '../slots';
import { CALLBACK_BODY_RETIRED, HOST_RECORDING_VERSION, hostRecordingSchema } from '../conformance';

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

  it("serves a run's waits on listenable edges as an optional family, and no callbacks (version 2)", () => {
    expect(HOST_FAMILIES['park.waits']).toEqual({ optional: true, methods: ['mark', 'open', 'arrivals', 'note'] });
    expect(Object.keys(HOST_FAMILIES)).not.toContain('park.callbacks');
    expect(hostMethodPaths().filter((path) => path.startsWith('park.callbacks'))).toEqual([]);
    // A host without the waits is not refused for it: such a run opens none.
    expect(missingHostMethods({ park: {} }).filter((path) => path.startsWith('park.waits'))).toEqual([]);
  });

  it('asks an adapter for its await keys, and never resolves an await or reads wake keys of it', () => {
    expect(ADAPTER_METHODS).toContain('awaitKeys');
    expect(ADAPTER_METHODS).not.toContain('resolveAwait');
    expect(ADAPTER_METHODS).not.toContain('wakeKeys');
  });
});

describe("the wake door's body", () => {
  const arrival = { edge: 'Comments', key: 'thread:c1', identity: 'k1', landing: { fields: { Text: 'hi' } } };

  it('is what arrived: one to a thousand arrivals, a gone record among them', () => {
    const gone = { edge: 'Comments', key: 'thread:c2', gone: true };
    expect(AdapterWakeBody.parse({ arrivals: [arrival, gone] })).toEqual({ arrivals: [arrival, gone] });
    expect(AdapterWakeBody.safeParse({ arrivals: [] }).success).toBe(false);
  });

  it('refuses keys first, by name, naming adapter protocol 2.5 and `arrivals`', () => {
    for (const body of [{ keys: ['thread:c1'] }, { keys: ['thread:c1'], arrivals: [arrival] }]) {
      const parsed = AdapterWakeBody.safeParse(body);
      expect(parsed.success).toBe(false);
      const first = parsed.error?.issues[0];
      expect(first?.path).toEqual(['keys']);
      expect(first?.message).toContain('adapter protocol 2.5');
      expect(first?.message).toContain('`arrivals`');
    }
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
    expect(/^Minor: (\d+)$/m.exec(read('adapter-protocol.md'))?.[1]).toBe(String(PROTOCOL_MINOR));
    expect(versionLine('system-caller.md')).toBe(SYSTEM_CALLER_VERSION);
    expect(versionLine('story-analysis.md')).toBe(STORY_ANALYSIS_VERSION);
  });

  it('the index is the CONTRACTS table, contract by contract', () => {
    const rows = [...read('README.md').matchAll(/^\| ([a-z-]+) \| \[[^\]]+\]\(([^)]+)\) \| (\d+) \| ([^|]+) \| ([^|]+) \|/gm)];
    const indexed = Object.fromEntries(
      rows.map(([, name, file, current, supported, deprecated]) => {
        expect(file).toBe(`${name}.md`);
        // A contract versioned 2.N says which minors it reads: `2 (minors 0–2)`.
        const minors = /^(.*) \(minors 0–(\d+)\)$/.exec(supported.trim());
        return [
          name,
          {
            current: Number(current),
            supported: versionList(minors === null ? supported.trim() : minors[1]),
            deprecated: versionList(deprecated.trim()),
            ...(minors === null ? {} : { minor: Number(minors[2]) }),
          },
        ];
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
// TypeScript and through the Rust (the movement artifact's `language_standing`,
// which answers against the artifact's own release), and its three refusals
// are the document's words in both.
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

  it('the Rust reads each pin as the document does, against a release of its own key', () => {
    const ownKey = compatibilityKey(LANGUAGE_VERSION);
    const ofThisKey = rows.filter(({ own }) => compatibilityKey(own) === ownKey);
    expect(ofThisKey.length).toBeGreaterThan(0);
    // A standing reads the release's key alone, so the artifact's own release
    // stands in for the row's.
    for (const { pin, own, standing } of ofThisKey) expect({ pin, own, standing: languageStanding(pin).standing }).toEqual({ pin, own, standing });
  });

  it('the Rust and the TypeScript answer every pin alike against this release', () => {
    for (const { pin } of rows) {
      expect({ pin, ...languageStanding(pin) }).toEqual({
        pin,
        standing: languageVersionStanding(pin),
        message: languageVersionDiagnostic(pin)?.message ?? null,
      });
    }
  });

  it('the three refusals are the document\'s, the Rust\'s and the TypeScript\'s', () => {
    const quoted = (label: string) => {
      const match = new RegExp(`^- \\*\\*${label}:\\*\\* "([^"]+)"$`, 'm').exec(doc);
      if (match === null) throw new Error(`language-versions.md no longer quotes the ${label} refusal as this test reads it`);
      return match[1];
    };
    const fill = (template: string, pin: string, own: string) => template.replaceAll('{pin}', pin).replaceAll('{own}', own);
    const cases = [
      { label: 'newer', pin: '99.0.0' },
      { label: 'older key', pin: '0.0.1' },
      { label: 'malformed', pin: 'banana' },
    ];
    for (const { label, pin } of cases) {
      expect(languageStanding(pin).message).toBe(fill(quoted(label), pin, LANGUAGE_VERSION));
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
    expect(() => refuseUnsupportedHostFamiliesVersion({ hostFamiliesVersion: 1 })).toThrow(
      'segment.open carries host families version 1, which this host does not serve (supported: 2)',
    );
    expect(() => refuseUnsupportedHostFamiliesVersion({ hostFamiliesVersion: 9 })).toThrow(
      'segment.open carries host families version 9, which this host does not serve (supported: 2)',
    );
    expect(() => refuseUnsupportedHostFamiliesVersion({})).toThrow(
      'segment.open carries host families version none, which this host does not serve (supported: 2)',
    );
  });
});

describe('a park state version is refused on read unless this release reads it', () => {
  it('passes the versions it reads: 1 (the TypeScript engine) and 3 (the Rust engine)', () => {
    expect(() => refuseUnsupportedParkStateVersion(PARK_STATE_VERSION)).not.toThrow();
    expect(() => refuseUnsupportedParkStateVersion(1)).not.toThrow();
  });

  it('refuses another version, or none, naming the contract, what it saw and what it reads', () => {
    // 0.12's: its awaits parked on keys no 0.13 host wakes.
    expect(() => refuseUnsupportedParkStateVersion(2)).toThrow(
      'the parked state carries park state version 2, which this release does not read (supported: 1, 3)',
    );
    expect(() => refuseUnsupportedParkStateVersion(undefined)).toThrow(
      'the parked state carries park state version none, which this release does not read (supported: 1, 3)',
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

describe('the host model request', () => {
  const request = { label: 'affinity.formatLocation', system: 's', userMessage: 'u' };

  it('may name the run it is for, which the models slot carries unchanged', () => {
    expect(HostModelRequest.parse({ ...request, runId: 'run_1' })).toEqual({ ...request, runId: 'run_1' });
    expect(ModelsCallRequest.parse({ ...request, runId: 'run_1', maxTokens: 10 })).toEqual({ ...request, runId: 'run_1', maxTokens: 10 });
  });

  it('is valid without one, as a call outside any run is', () => {
    expect(HostModelRequest.parse(request)).toEqual(request);
  });

  it('refuses a run id that is not a string', () => {
    expect(HostModelRequest.safeParse({ ...request, runId: 7 }).success).toBe(false);
  });
});

describe('a host recording', () => {
  const resumed = {
    kit: 'host',
    version: HOST_RECORDING_VERSION,
    input: {
      source: 'movement m() {}',
      languageVersion: LANGUAGE_VERSION,
      event: { adapterType: 'manual' },
      teamId: 'team-1',
      catalog: { adapters: {}, credentials: {}, plugins: {} },
      state: { address: 's0' },
    },
    methods: ['park.wake'],
    requests: [{ family: 'park', method: 'wake', args: { segmentId: 'seg-1', waitId: 'w1' }, after: [] }],
    result: {},
  };

  it('records a resume, a wake naming its wait among its requests', () => {
    expect(hostRecordingSchema.safeParse({ ...resumed, entry: 'resume' }).success).toBe(true);
  });

  it('is version 3, and reads a version 2 recording as it always did', () => {
    expect(HOST_RECORDING_VERSION).toBe(3);
    expect(hostRecordingSchema.safeParse({ ...resumed, version: 2, entry: 'resume' }).success).toBe(true);
    expect(hostRecordingSchema.safeParse({ ...resumed, version: 4, entry: 'resume' }).success).toBe(false);
  });

  it.each([2, 3])('refuses a version %i recording of a callback body, naming its retirement', (version) => {
    const body = { ...resumed, version, entry: 'callbackBody', input: { ...resumed.input, values: {}, callIndex: 0 } };
    const parsed = hostRecordingSchema.safeParse(body);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ path: ['entry'], message: CALLBACK_BODY_RETIRED })]);
    expect(CALLBACK_BODY_RETIRED).toMatch(/^callbackBody retired in 0\.13/);
  });

  it('refuses a recording whose host served callbacks: they are on no manifest', () => {
    const minted = { ...resumed, entry: 'resume', methods: ['park.callbacks.mint'] };
    expect(hostRecordingSchema.safeParse(minted).success).toBe(false);
  });
});
