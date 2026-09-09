/**
 * `node.summary` after the summariser moved into the store (D43a).
 *
 * The move changed WHERE the quoted source text is read from — knowledge's own
 * `node_resource.excerpt` instead of a backwards read into `public.resource` →
 * `public.raw_text`. It must not have changed what the text SAYS: `v.summary`
 * is an exposed meta field, so an already-linked node has to regenerate to the
 * same string it had.
 *
 * The fixture below is the old serialiser's output, written out by hand from
 * the shape it produced (`## <type>`, `key: value` per non-null property, then
 * a blank line, `### Source Material`, and each excerpt on its own line).
 */

import { serializeNodeAsText, type SummarisableNode } from '../summarize';

const NODE: SummarisableNode = {
  id: 'node-1' as SummarisableNode['id'],
  nodeTypeName: 'Organisation',
  properties: [
    ['Name', 'ACME Corp'],
    ['Founded', 2019],
    ['Active', true],
    ['Website', null],
  ],
  excerpts: [
    'ACME Corp raised a seed round of 3M EUR led by Northstar Ventures.',
    'ACME Corp',
  ],
};

describe('serializeNodeAsText — byte-identical to what agents already read', () => {
  it('composes type, properties and source material in the established shape', () => {
    expect(serializeNodeAsText(NODE)).toBe(
      [
        '## Organisation',
        'Name: ACME Corp',
        'Founded: 2019',
        'Active: true',
        '',
        '### Source Material',
        'ACME Corp raised a seed round of 3M EUR led by Northstar Ventures.',
        'ACME Corp',
      ].join('\n'),
    );
  });

  it('omits null-valued properties rather than printing them empty', () => {
    // `Website: null` would be a claim; its absence is the truth.
    expect(serializeNodeAsText(NODE)).not.toContain('Website');
  });

  it('omits the Source Material section entirely when nothing is quoted', () => {
    expect(serializeNodeAsText({ ...NODE, excerpts: [] })).toBe(
      ['## Organisation', 'Name: ACME Corp', 'Founded: 2019', 'Active: true'].join('\n'),
    );
  });
});
