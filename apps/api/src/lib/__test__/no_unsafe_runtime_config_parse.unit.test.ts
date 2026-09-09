/**
 * Repo-wide lint: no runtime config parser may call `.parse(...)` directly.
 *
 * Standing invariant: any zod parser whose name matches
 * `\w*[Cc]onfig(Parser|Schema)` is a runtime parser for a stored config
 * blob. Those rows can drift from the current schema (legacy data,
 * hand-edited rows, intermediate provisioning states), so the runtime
 * path must `safeParseConfig` and degrade gracefully rather than
 * `.parse()` and throw. The J2 dev-loop crash was one such throw becoming
 * an unhandled rejection on a 500 from `getInboundAdapter`.
 *
 * Implementation: walks every `*.ts` file under `apps/api/src` (skipping
 * `__test__`, `build`, generated dirs), regexes for the banned pattern,
 * fails when an occurrence appears that isn't on the explicit allowlist.
 *
 * Allowlist: build-time / migration / one-shot code where throwing on
 * invalid input is the right answer (the file is invalid, the build
 * should fail). The helper file itself + the lint file are allowlisted
 * because they reference the pattern in comments / regex.
 *
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..', '..', '..', '..');
const API_SRC = join(REPO_ROOT, 'apps', 'api', 'src');

// Files where calling `.parse(...)` on a *Config* schema is intentional
// and acceptable. Each entry is a path relative to repo root + a one-line
// rationale that becomes part of the failure message for transparency.
interface AllowlistEntry {
  /** Path relative to repo root. */
  path: string;
  /** Why this site is exempt — printed in the failure message if removed. */
  rationale: string;
}

const ALLOWLIST: AllowlistEntry[] = [
  {
    path: 'apps/api/src/lib/safe-config-parse.ts',
    rationale:
      'the helper itself — references `someConfigParser.parse(...)` in ' +
      "its file-level comment as the anti-pattern it's designed to replace",
  },
  // The lint walker skips `__test__` directories outright (tests
  // legitimately call `.parse()` to assert parser behavior). Production
  // sites that need exemption should be added here with a one-line
  // rationale of why throwing is the right answer.
];

// Pattern: any identifier ending in `ConfigParser` or `ConfigSchema`
// (PascalCase or camelCase) followed by `.parse(`. Allows `.safeParse(`
// because that returns a result rather than throwing — the desired shape.
const BANNED_PATTERN = /\b(\w*[Cc]onfig(?:Parser|Schema))\.parse\(/g;

interface Hit {
  /** Path relative to repo root, for matching the allowlist. */
  relPath: string;
  /** 1-indexed line number. */
  line: number;
  /** The matched parser identifier (e.g. `emailInputConfigParser`). */
  identifier: string;
  /** The text of the offending line, trimmed. */
  snippet: string;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (
      entry === 'node_modules' ||
      entry === 'build' ||
      entry === 'generated' ||
      // Test files legitimately call `.parse()` to assert parser
      // behavior — e.g. the J2 integration test parses a freshly-provisioned
      // row to prove it's valid. That's the test's job, not a runtime hazard.
      entry === '__test__'
    ) {
      continue;
    }
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

function findHits(): Hit[] {
  const hits: Hit[] = [];
  for (const path of listTsFiles(API_SRC)) {
    const source = readFileSync(path, 'utf8');
    if (!BANNED_PATTERN.test(source)) {
      // Reset lastIndex when the file has no matches; the cheap test
      // above lets us skip the per-line walk on most files.
      BANNED_PATTERN.lastIndex = 0;
      continue;
    }
    BANNED_PATTERN.lastIndex = 0;
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      let match: RegExpExecArray | null;
      const lineText = lines[i];
      const lineRe = new RegExp(BANNED_PATTERN.source, 'g');
      while ((match = lineRe.exec(lineText)) !== null) {
        hits.push({
          relPath: relative(REPO_ROOT, path),
          line: i + 1,
          identifier: match[1],
          snippet: lineText.trim(),
        });
      }
    }
  }
  return hits;
}

describe('runtime config parsers — no unsafe .parse() (J3 standing rule)', () => {
  it('every match is either allowlisted or under safeParseConfig', () => {
    const hits = findHits();
    const allowedPaths = new Set(ALLOWLIST.map((a) => a.path));
    const violations = hits.filter((h) => !allowedPaths.has(h.relPath));

    if (violations.length > 0) {
      const summary = violations
        .map(
          (v) =>
            `  ${v.relPath}:${v.line}\n    ${v.snippet}\n    (parser: ${v.identifier})`,
        )
        .join('\n');
      throw new Error(
        `${violations.length} runtime config parser(s) call .parse() directly.\n\n` +
          `Replace with \`safeParseConfig(parser, raw, context)\` from ` +
          `apps/api/src/lib/safe-config-parse.ts — the call site handles ` +
          `the \`{ ok: false }\` branch by skipping / surfacing as invalid ` +
          `rather than throwing.\n\n` +
          `Offending sites:\n${summary}\n\n` +
          `If a site is genuinely build-time / one-shot / migration code, ` +
          `add it to ALLOWLIST in this file with a rationale.`,
      );
    }
  });

  it('every allowlist entry actually contains a matched pattern (no stale exemptions)', () => {
    const hits = findHits();
    const hitPaths = new Set(hits.map((h) => h.relPath));
    const stale = ALLOWLIST.filter((a) => !hitPaths.has(a.path));
    if (stale.length > 0) {
      const summary = stale.map((a) => `  ${a.path} — ${a.rationale}`).join('\n');
      throw new Error(
        `${stale.length} allowlist entry/entries no longer contain the ` +
          `banned pattern — they can be removed:\n${summary}`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Sanity check — the lint catches a deliberate violation in synthetic text.
// If this ever stops failing, the regex is broken.
// ---------------------------------------------------------------------------

describe('lint sanity — deliberate violation still trips the regex', () => {
  it('catches `someConfigParser.parse(input.config)` in synthetic source', () => {
    const synthetic = 'const cfg = mailgunConfigParser.parse(input.config);';
    const re = new RegExp(BANNED_PATTERN.source, 'g');
    expect(re.test(synthetic)).toBe(true);
  });

  it('catches `SomeConfigSchema.parse(node.config)` in synthetic source', () => {
    const synthetic = 'const cfg = ObjectConfigSchema.parse(node.config);';
    const re = new RegExp(BANNED_PATTERN.source, 'g');
    expect(re.test(synthetic)).toBe(true);
  });

  it('does NOT trip on `.safeParse(...)` — the desired shape', () => {
    const synthetic = 'const r = mailgunConfigParser.safeParse(input.config);';
    const re = new RegExp(BANNED_PATTERN.source, 'g');
    expect(re.test(synthetic)).toBe(false);
  });

  it('does NOT trip on unrelated parser names', () => {
    const synthetic = 'const id = z.string().uuid().parse(input.id);';
    const re = new RegExp(BANNED_PATTERN.source, 'g');
    expect(re.test(synthetic)).toBe(false);
  });
});
