// G1-content K.1/K.3/K.4 — extract-step bundle projection tests.
//
// These tests cover `projectDatumForBundle`, the small helper added in
// `engine/evaluator/extract.ts` so that materialised-record values
// reached via `msg-[:files]->.<__record__>` (the generic source
// adapter's pseudo-field, see `generic_source_adapter.ts`) project
// into Resource-shaped POJOs that `bundle.ts:isResource` recognises.
// Without this projection, files / source-message records would
// flow through `#extract.data:` as opaque objects and never land in
// `bundle.resources` — defeating R8's per-resource fact extraction
// lifecycle (K.4) and the per-PDF evidence anchor (K.3).
//
// Brief: plans/2026-05-19-tg-extraction-parity/_execution/wave-1/G1-content.md

import { projectDatumForBundle } from '../engine/evaluator/extract';

describe('projectDatumForBundle (G1-content)', () => {
  it('passes primitives and strings through untouched', () => {
    expect(projectDatumForBundle('hello')).toBe('hello');
    expect(projectDatumForBundle(42)).toBe(42);
    expect(projectDatumForBundle(true)).toBe(true);
    expect(projectDatumForBundle(null)).toBeNull();
    expect(projectDatumForBundle(undefined)).toBeUndefined();
  });

  it('passes already-Resource-shaped POJOs through verbatim (externalId path)', () => {
    // The W3-B2-era adapter path produces shapes with `externalId` /
    // optional `id`. Identity preservation matters because
    // `bundle.assembleBundle` dedupes by reference.
    const resource = {
      externalId: 'slack:F123:body',
      type: 'TEXT',
      name: 'foo',
      content: 'body',
    };
    expect(projectDatumForBundle(resource)).toBe(resource);
  });

  it('passes legacy resourceId-shaped POJOs through verbatim (back-compat)', () => {
    // The pre-W3-B2 shape (`resourceId` only) is still accepted for
    // back-compat — `bundle.ts:isResource` doesn't currently match it
    // but the projection helper does not crash either.
    const resource = {
      resourceId: 'res-1',
      type: 'TEXT',
      name: 'foo',
      content: 'body',
    };
    expect(projectDatumForBundle(resource)).toBe(resource);
  });

  it('projects a materialised record with a resourceId property into externalId on the Resource POJO', () => {
    // Per W3-B2 — generic-source materialisation uses `resourceId`
    // as the source handle name on the materialised value. The
    // projection translates it to `externalId` on the Resource POJO
    // so the bundle assembler picks it up and the persistence layer
    // never mistakes an external string for an internal UUID.
    const materialisedFile = {
      properties: {
        resourceId: 'slack:F123:body',
        type: 'FILE',
        name: 'pitch-deck.pdf',
        contentType: 'application/pdf',
        content: 'https://files.slack.example/F123/pitch-deck.pdf',
      },
      edges: {},
    };
    const projected = projectDatumForBundle(materialisedFile) as {
      externalId: string;
      id?: string;
      type: string;
      name: string;
      contentType: string;
      content: string;
    };
    expect(projected.externalId).toBe('slack:F123:body');
    expect(projected.id).toBeUndefined();
    expect(projected.type).toBe('FILE');
    expect(projected.name).toBe('pitch-deck.pdf');
    expect(projected.contentType).toBe('application/pdf');
    expect(projected.content).toBe(
      'https://files.slack.example/F123/pitch-deck.pdf',
    );
  });

  it('projects a materialised record with an externalId property the same way', () => {
    // Authors using the new convention name the slot `externalId` on
    // the generic shape. Both `resourceId` and `externalId` project
    // identically.
    const materialisedFile = {
      properties: {
        externalId: 'slack:F123:body',
        type: 'FILE',
        content: 'whatever',
      },
      edges: {},
    };
    const projected = projectDatumForBundle(materialisedFile) as {
      externalId: string;
      type: string;
      content: string;
    };
    expect(projected.externalId).toBe('slack:F123:body');
    expect(projected.type).toBe('FILE');
    expect(projected.content).toBe('whatever');
  });

  it('projects a source-message record (K.4 path) into a TEXT Resource POJO with externalId', () => {
    // The standalone TG body's `data:` walks `msg.__record__`. The
    // generic source adapter returns the materialised root value;
    // when the input mapping projected a resourceId + type onto the
    // root (per the wave-1 golden-path seed), this fires.
    const materialisedMsg = {
      properties: {
        resourceId: '1700000000.000100',
        type: 'TEXT',
        sent_at: '2026-05-20T12:00:00Z',
        sender_name: 'U-Author',
        content: 'Pre-seed @ $5M cap. Founders: ...',
      },
      edges: {},
    };
    const projected = projectDatumForBundle(materialisedMsg) as {
      externalId: string;
      type: string;
      content: string;
    };
    expect(projected.externalId).toBe('1700000000.000100');
    expect(projected.type).toBe('TEXT');
    expect(projected.content).toBe('Pre-seed @ $5M cap. Founders: ...');
  });

  it('omits optional Resource fields when the source record lacks them', () => {
    const minimal = {
      properties: { resourceId: 'res-only' },
      edges: {},
    };
    const projected = projectDatumForBundle(minimal);
    expect(projected).toEqual({ externalId: 'res-only' });
  });

  it('returns materialised records without a resourceId or externalId verbatim (no false-positive promotion)', () => {
    // A record without an external handle is not a Resource. The bundle
    // assembler stringifies it as a FRAGMENT segment, which is fine.
    const nonResourceRecord = {
      properties: { name: 'just a record' },
      edges: {},
    };
    expect(projectDatumForBundle(nonResourceRecord)).toBe(nonResourceRecord);
  });

  it('returns ephemeral-node-shaped objects untouched', () => {
    // Ephemerals carry `kind: 'ephemeral-node'` + `nodeId` but no
    // top-level `resourceId`. They must pass through so EXTRACT_VALUE
    // descendants can read ephemeral.data fields downstream.
    const ephemeral = {
      kind: 'ephemeral-node',
      nodeId: 'ephemeral:x#1',
      originRef: { kind: 'extract', extractStepId: 'x#1' },
      data: {},
    };
    expect(projectDatumForBundle(ephemeral)).toBe(ephemeral);
  });
});
