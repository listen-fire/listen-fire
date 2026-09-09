/**
 * Template-removal lint — agent layer is template-free.
 *
 * Triggers+TGs reframe (2026-05-28): the Setup / Translation / Ontology
 * agents no longer expose template tools. The `getDomainTemplate`,
 * `listTemplates`, and `materializeTemplate` tool definitions + their
 * prompt mentions were retired in chunk A. This test prevents accidental
 * reintroduction.
 *
 * Templates as code (`apps/api/src/lib/knowledge/templates/`) remain on
 * disk for `dev:seed` + future admin use — this lint scopes only to the
 * agent files.
 *
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const KNOWLEDGE_DIR = join(__dirname, '..');

const AGENT_FILES = [
  'ontology_agent.ts',
];

// Tool names that must not appear in any agent file.
const FORBIDDEN_TOOL_NAMES = [
  'getDomainTemplate',
  'listTemplates',
  'materializeTemplate',
];

describe('template-removal lint — agent layer is template-free', () => {
  for (const file of AGENT_FILES) {
    const path = join(KNOWLEDGE_DIR, file);
    const src = readFileSync(path, 'utf8');

    for (const toolName of FORBIDDEN_TOOL_NAMES) {
      it(`${file} does not define or reference the \`${toolName}\` tool`, () => {
        // Two patterns we care about:
        //   1. Tool-definition shape: `name: '<toolName>'` in a tool-defs
        //      array.
        //   2. Identifier references: bare mention of the tool name in
        //      prose / impl that would resurrect the surface.
        const defPattern = new RegExp(`name:\\s*['"\`]${toolName}['"\`]`);
        const idPattern = new RegExp(`\\b${toolName}\\b`);
        expect({
          file,
          tool: toolName,
          hasDef: defPattern.test(src),
          hasIdRef: idPattern.test(src),
        }).toEqual({
          file,
          tool: toolName,
          hasDef: false,
          hasIdRef: false,
        });
      });
    }
  }
});
