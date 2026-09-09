/**
 * Unit tests for the deterministic automation describer. The helper
 * drives the headline sentence on `/automations/[id]` (and, soon,
 * row-level one-liners on the list + home).
 *
 * The headline is *source-only*: it names what kicks the automation
 * off and nothing else (the program tree below the headline lays out
 * the actions). So the grammar to keep sturdy is:
 *
 *   - placeholder TG (no roots) — graceful "setup in progress" sentence
 *   - a wired TG (>=1 root) → the source phrase for the trigger kind
 *   - oddball trigger kinds → fallback source phrase
 *   - missing / malformed inputs → no throws, sensible fallback
 *
 * The action/destination/identity of the TG body is intentionally NOT
 * reflected here — only whether the automation is wired at all.
 *
 */

import { describeAutomation } from '../describe';

describe('describeAutomation', () => {
  it('returns the placeholder sentence when no TGs are bound', () => {
    const sentence = describeAutomation({
      trigger: { kind: 'CUSTOM_EMAIL', config: { key: 'dealflow' } },
      tgBodies: [],
    });
    expect(sentence).toMatch(/Setup in progress/);
    expect(sentence.endsWith('.')).toBe(true);
  });

  it('returns the placeholder sentence when every bound TG has no roots', () => {
    const sentence = describeAutomation({
      trigger: { kind: 'CUSTOM_EMAIL', config: { key: 'dealflow' } },
      tgBodies: [
        {
          roots: [],
          sourceSchemaRef: { kind: 'dynamic', adapterKind: 'CUSTOM_EMAIL', credentialsId: null },
          targetSchemaRef: { kind: 'adapter', adapterType: 'attio', credentialsId: 'c1' },
        },
      ],
    });
    expect(sentence).toMatch(/Setup in progress/);
  });

  it('describes a wired email trigger by its source only', () => {
    const sentence = describeAutomation({
      trigger: { kind: 'CUSTOM_EMAIL', config: { key: 'dealflow' } },
      tgBodies: [
        {
          roots: [mkActionRoot('attio:companies')],
          sourceSchemaRef: { kind: 'dynamic', adapterKind: 'CUSTOM_EMAIL', credentialsId: null },
          targetSchemaRef: { kind: 'adapter', adapterType: 'attio', credentialsId: 'c1' },
        },
      ],
    });
    expect(sentence).toBe('When an email arrives tagged `dealflow`.');
  });

  it('uses the full address when the trigger config records one', () => {
    const sentence = describeAutomation({
      trigger: { kind: 'CUSTOM_EMAIL', config: { address: 'deals@inbox.example.com' } },
      tgBodies: [
        {
          roots: [mkActionRoot('attio:companies')],
          sourceSchemaRef: { kind: 'dynamic', adapterKind: 'CUSTOM_EMAIL', credentialsId: null },
          targetSchemaRef: { kind: 'adapter', adapterType: 'attio', credentialsId: 'c1' },
        },
      ],
    });
    expect(sentence).toBe('When you send an email to deals@inbox.example.com.');
  });

  it('describes a Slack trigger by its channel', () => {
    const sentence = describeAutomation({
      trigger: { kind: 'SLACK', config: { channel: '#dealflow' } },
      tgBodies: [
        {
          roots: [mkActionRoot('node-type:abc')],
          sourceSchemaRef: { kind: 'dynamic', adapterKind: 'SLACK', credentialsId: null },
          targetSchemaRef: { kind: 'knowledge-graph' },
        },
      ],
    });
    expect(sentence).toBe('When a Slack message arrives in #dealflow.');
  });

  it('describes an Attio trigger via the adapter-owned vocabulary', () => {
    const sentence = describeAutomation({
      trigger: { kind: 'ATTIO', config: {} },
      tgBodies: [
        {
          roots: [mkActionRoot('node-type:abc')],
          sourceSchemaRef: { kind: 'dynamic', adapterKind: 'ATTIO', credentialsId: null },
          targetSchemaRef: { kind: 'knowledge-graph' },
        },
      ],
    });
    expect(sentence).toBe('When a record changes in Attio.');
  });

  it('describes a KG_MUTATION trigger via the adapter-owned vocabulary', () => {
    const sentence = describeAutomation({
      trigger: { kind: 'KG_MUTATION', config: {} },
      tgBodies: [
        {
          roots: [mkActionRoot('attio:companies')],
          sourceSchemaRef: { kind: 'knowledge-graph' },
          targetSchemaRef: { kind: 'adapter', adapterType: 'attio', credentialsId: 'c1' },
        },
      ],
    });
    expect(sentence).toBe('When data changes in your knowledge graph.');
  });

  it('keeps centralised phrasing for pre-adapter legacy kinds', () => {
    const bodies = [
      {
        roots: [mkActionRoot('node-type:abc')],
        sourceSchemaRef: { kind: 'dynamic', adapterKind: 'API', credentialsId: null },
        targetSchemaRef: { kind: 'knowledge-graph' },
      },
    ];
    const sentenceFor = (kind: string) =>
      describeAutomation({ trigger: { kind, config: {} }, tgBodies: bodies });
    expect(sentenceFor('API')).toBe('When the API is called.');
    expect(sentenceFor('WEB_QUESTION')).toBe('When data is submitted directly to Listen-Fire.');
    expect(sentenceFor('CHROME_EXTENSION')).toBe('When the Chrome extension captures content.');
  });

  it('falls back to a generic source phrase for unknown kinds', () => {
    const sentence = describeAutomation({
      trigger: { kind: 'WEIRD_NEW_KIND', config: {} },
      tgBodies: [
        {
          roots: [mkActionRoot('attio:companies')],
          sourceSchemaRef: { kind: 'dynamic', adapterKind: 'WEIRD_NEW_KIND', credentialsId: null },
          targetSchemaRef: { kind: 'adapter', adapterType: 'attio', credentialsId: 'c1' },
        },
      ],
    });
    expect(sentence).toBe('When a Weird New Kind event arrives.');
  });

  it('does not reflect the action/destination — the program tree owns that', () => {
    // Even a richly-configured multi-root TG yields a source-only headline;
    // the "what happens" tree below the headline shows the actions.
    const sentence = describeAutomation({
      trigger: { kind: 'CUSTOM_EMAIL', config: { key: 'dealflow' } },
      tgBodies: [
        {
          roots: [
            mkActionRoot('attio:companies', [{ expr: { type: 'property', propertyTypeId: 'name' } }]),
            mkActionRoot('attio:people'),
            mkActionRoot('attio:deals'),
          ],
          sourceSchemaRef: { kind: 'dynamic', adapterKind: 'CUSTOM_EMAIL', credentialsId: null },
          targetSchemaRef: { kind: 'adapter', adapterType: 'attio', credentialsId: 'c1' },
        },
      ],
    });
    expect(sentence).toBe('When an email arrives tagged `dealflow`.');
  });

  it('does not throw on malformed bodies; produces the placeholder sentence', () => {
    const sentence = describeAutomation({
      trigger: { kind: 'CUSTOM_EMAIL', config: null },
      tgBodies: [{ not: 'a body' }, null, 'garbage'],
    });
    expect(sentence).toMatch(/Setup in progress/);
  });
});

// Helper to build a minimal action root — most tests only care that a
// root exists (so the automation reads as "wired"), not its shape.
function mkActionRoot(
  targetTypeRef: string,
  firstGroup?: Array<{ expr: { type: string; propertyTypeId?: string; fieldId?: string }; fuzzy?: boolean }>,
) {
  return {
    id: `node-${targetTypeRef}`,
    kind: 'action' as const,
    targetTypeRef,
    traversal: [],
    fieldMappings: [],
    children: [],
    ...(firstGroup ? { uniquenessConstraints: [firstGroup] } : {}),
  };
}
