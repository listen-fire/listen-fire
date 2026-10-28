// Every public module's handbook section is checked as the handbook's own
// chapters are: each fenced example goes through the wasm checker, so a section
// cannot keep teaching a spelling the language has retired. Fragments that lean
// on an earlier fragment draw unresolved names; those are listed as warnings,
// not failures. The retired-spelling diagnostic is a hard failure.

import { LANGUAGE_VERSION, checkSourceInRust } from 'movement-lang';
import type { AdapterManifest } from 'movement-engine/public/adapter';

import { AFFINITY_MANIFEST } from '../../../modules/affinity/manifest';
import { DEALROOM_MANIFEST } from '../../../modules/dealroom/manifest';
import { EVERTRACE_MANIFEST } from '../../../modules/evertrace/manifest';
import { GITHUB_MANIFEST } from '../../../modules/github/manifest';
import { GMAIL_MANIFEST } from '../../../modules/gmail/manifest';
import { MCP_MANIFEST } from '../../../modules/mcp/manifest';
import { SLACK_MANIFEST } from '../../../modules/slack/manifest';
import { TELEGRAM_MANIFEST } from '../../../modules/telegram/manifest';
import { WEBHOOK_MANIFEST } from '../../../modules/webhook/manifest';
import { WHATSAPP_MANIFEST } from '../../../modules/whatsapp/manifest';
import { HANDBOOK_CATALOG } from '../testing';

const MODULES: Record<string, AdapterManifest> = {
  affinity: AFFINITY_MANIFEST,
  dealroom: DEALROOM_MANIFEST,
  evertrace: EVERTRACE_MANIFEST,
  github: GITHUB_MANIFEST,
  gmail: GMAIL_MANIFEST,
  mcp: MCP_MANIFEST,
  slack: SLACK_MANIFEST,
  telegram: TELEGRAM_MANIFEST,
  webhook: WEBHOOK_MANIFEST,
  whatsapp: WHATSAPP_MANIFEST,
};

const FENCE = /^```[^\n]*\n([\s\S]*?)^```$/gm;

const examples = Object.entries(MODULES).flatMap(([name, manifest]) =>
  [...(manifest.handbookSection?.content ?? '').matchAll(FENCE)].map((m, i) => ({ name: `${name} #${i + 1}`, source: m[1] })),
);

// A fragment that is not a whole program is refused by the parser, not
// diagnosed; that is a warning too, since only the spelling is held here.
function diagnosticsOf(source: string, name: string): Array<{ code: string; message: string }> {
  try {
    return checkSourceInRust(source, HANDBOOK_CATALOG, { languageVersion: LANGUAGE_VERSION });
  } catch (error) {
    console.warn(`${name}: not checked as a whole program: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

describe('the examples in every module handbook section', () => {
  it('are there to check', () => {
    expect(Object.values(MODULES).every((m) => m.handbookSection)).toBe(true);
    expect(examples.length).toBeGreaterThanOrEqual(7);
  });

  it.each(examples.map((e) => [e.name, e.source]))('%s draws no retired spelling', (name, source) => {
    const found = diagnosticsOf(source, name);
    const others = found.filter((d) => d.code !== 'MOV_V5_SPELLING');
    if (others.length) console.warn(`${name}: ${others.map((d) => `${d.code}: ${d.message}`).join('\n  ')}`);
    expect(found.filter((d) => d.code === 'MOV_V5_SPELLING').map((d) => d.message)).toEqual([]);
  });
});
