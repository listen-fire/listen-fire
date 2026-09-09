// Movement engine — provenance as the value model (E4).
//
// Every runtime value the interpreter produces is a (value, provenance)
// pair, propagated automatically — zero language surface. The pair rides
// NEXT TO the value (`MovementEvalResult` in ./expression.ts), never
// inside it: values stay plain JS data, so adapters receive exactly what
// they always received, and equality/comparison ignore provenance by
// construction rather than by unwrapping discipline.
//
// Origins (6_engine.md §"Provenance is the value model"):
//   - extract field reads carry { extraction site, field description,
//     data sources in context at that stage } — `through` fences make
//     stage context precise, so evidence precision falls out of the
//     staging semantics; the LLM's verbatim quote rides along;
//   - source property reads carry { instance, record, field };
//   - handle reads carry the earlier write (provenance chains across
//     systems — the referenced write's own per-field trails continue
//     the chain);
//   - `AI()` carries prompt + inputs (the origin kind is modelled here;
//     its production site lands when the engine evaluates `AI()`);
//   - literals carry their source span (the program is part of the
//     trail).
//
// Expressions union operand trails taint-style. A value additionally
// keeps a `direct` origin while it flows UN-transformed from its source
// (extract / property read, branch selection, single-position collapse)
// — the TG engine's provenance-faithfulness rule (3b §3.4). `direct`
// is what translates to `WriteInput.evidence`: a transformed value's
// quote would be a misleading citation, so transforms keep the taint
// union but drop `direct`.
//
// Trail size discipline: shared refs are interned, not copied — one
// `ExtractSiteRef` per planned LLM call site (every field origin of
// every emission points at the same object), write origins reference
// the run's write by INDEX into `MovementRunResult.writes`, and the
// summarised form (`SummarisedOrigin`) stores refs, not blobs: site
// detail lives once in the run's `extractionSites` catalog; per-field
// entries carry only the field name, its description, and the verbatim
// quote. Unions dedupe by object identity, which interning makes
// meaningful.

import type { Span } from 'movement-lang';
import type { FieldEvidence } from '../translation_graph/adapter';

// ── Origins ─────────────────────────────────────────────────────────────────

/**
 * One planned extraction LLM call site — interned: created once per
 * (node, stage) call by the materialiser and shared by reference across
 * every origin it produces. `dataSources` is the data context the call
 * saw: the `from` slots' own origins plus one `enrichment` entry per
 * `through` plugin whose output was in context at this stage.
 */
export interface ExtractSiteRef {
  /** The call's response key (`x:<node>#<n>`) — unique within a run. */
  siteId: string;
  /** The extract tree node's name. */
  node: string;
  /** The node's authored description. */
  description: string;
  /** Which stage of the node this call extracted. */
  stage: number;
  /** Assigned by the materialiser when the call is issued (the region
   *  is built immediately before its call, so this is never observed
   *  unset by origin consumers). */
  dataSources: ProvenanceOrigin[];
}

export type ProvenanceOrigin =
  /** A property read off a source position (the event, a resource-free
   *  adapter read). `instance` is the constructed instance's name in the
   *  movement file — the program-level identity of the system read. */
  | {
      kind: 'source_field';
      instance: string;
      adapterType: string;
      recordType?: string;
      externalId?: string;
      field: string;
    }
  /** An extracted field (or, with `field` absent, an extracted entity
   *  itself). `quote` is the LLM's verbatim supporting quote. */
  | {
      kind: 'extraction';
      site: ExtractSiteRef;
      field?: string;
      description?: string;
      quote?: string;
    }
  /** A read off an earlier write's handle — `writeIndex` indexes the
   *  run's `MovementRunResult.writes`, whose own per-field provenance
   *  continues the chain across systems. */
  | { kind: 'write'; writeIndex: number; externalId?: string; field?: string }
  /** A field read off one of the event's resources. */
  | { kind: 'resource'; externalId?: string; name?: string; field?: string }
  /** A `through` plugin whose output was in extraction context. */
  | { kind: 'enrichment'; plugin: string }
  /** The extracted TEXT of a source file (an attachment `FileRef`) that
   *  fed an extraction. `rawTextId` links to the stored, deduped text;
   *  `handle`/`name`/`contentType` identify the file the text came from,
   *  so extracted-field evidence traces back to the attachment. */
  | {
      kind: 'file';
      rawTextId?: string;
      handle?: string;
      name?: string;
      contentType?: string;
    }
  /** An `AI()` evaluation — prompt plus the origins of its inputs.
   *  Modelled for the value union; produced once the engine runs AI(). */
  | { kind: 'ai'; prompt: string; inputs: ProvenanceOrigin[] }
  /** A literal in the movement text — the span locates it in the file. */
  | { kind: 'literal'; span?: Span }
  /** An ambient meta value (`@user_email`, `@current_date`, …) —
   *  literal-ish: the value comes from the dispatch context, not from
   *  any record, so the key is the whole story. */
  | { kind: 'meta'; key: string };

// ── The trail ───────────────────────────────────────────────────────────────

export interface Provenance {
  /** Every origin that influenced the value (taint-style union). */
  origins: ProvenanceOrigin[];
  /**
   * The single origin the value arrived from UN-transformed, when it
   * did (provenance-faithfulness, TG 3b §3.4). Drives evidence
   * translation; transforms drop it while keeping `origins`.
   */
  direct?: ProvenanceOrigin;
}

export const NO_PROVENANCE: Provenance = Object.freeze({ origins: [] });

/** A value read straight off one origin — faithful by definition. */
export function fromOrigin(origin: ProvenanceOrigin): Provenance {
  return { origins: [origin], direct: origin };
}

/** Taint union: every operand's origins, deduped by object identity
 *  (interned refs make identity dedupe meaningful), no `direct` — a
 *  combined value is justified by no single origin. */
export function unionProvenance(
  parts: ReadonlyArray<Provenance | undefined>,
): Provenance {
  const seen = new Set<ProvenanceOrigin>();
  const origins: ProvenanceOrigin[] = [];
  for (const part of parts) {
    for (const origin of part?.origins ?? []) {
      if (seen.has(origin)) continue;
      seen.add(origin);
      origins.push(origin);
    }
  }
  return { origins };
}

/** The trail through a transformation: origins survive, `direct` does
 *  not (the transformed value is no longer justified by the quote). */
export function transformed(provenance: Provenance): Provenance {
  return provenance.direct === undefined
    ? provenance
    : { origins: provenance.origins };
}

/**
 * Translate a field's trail into the adapter contract's per-field
 * evidence — exactly the TG engine's rule (today's model is the special
 * case): only a value that arrived UN-transformed from an extraction,
 * with a verbatim quote, earns a citation. The KG adapter persists it
 * as its native evidence rows; adapters without an evidence sink
 * ignore it.
 */
export function fieldEvidenceFromProvenance(
  provenance: Provenance,
): FieldEvidence | undefined {
  const direct = provenance.direct;
  if (direct?.kind !== 'extraction' || !direct.quote) return undefined;
  return { quote: direct.quote, type: 'extraction' };
}

// ── Summarisation (the firing record's currency) ────────────────────────────

/**
 * A JSON-able, ref-not-blob projection of an origin for
 * `MovementRunResult.writes[*].provenance` (trigger_run recording):
 * extraction sites collapse to their id (detail interned once in the
 * run's `extractionSites`), earlier writes stay an index into the same
 * result's `writes`.
 */
export type SummarisedOrigin =
  | {
      kind: 'source_field';
      instance: string;
      adapterType: string;
      recordType?: string;
      externalId?: string;
      field: string;
    }
  | { kind: 'extraction'; site: string; field?: string; description?: string; quote?: string }
  | { kind: 'write'; write: number; externalId?: string; field?: string }
  | { kind: 'resource'; externalId?: string; name?: string; field?: string }
  | { kind: 'enrichment'; plugin: string }
  | {
      kind: 'file';
      rawTextId?: string;
      handle?: string;
      name?: string;
      contentType?: string;
    }
  | { kind: 'ai'; prompt: string }
  | { kind: 'literal'; span?: Span }
  | { kind: 'meta'; key: string };

/** One extraction call site, summarised once per run. */
export interface ExtractSiteSummary {
  node: string;
  description: string;
  stage: number;
  dataSources: SummarisedOrigin[];
}

/**
 * Summarises trails for the run result, interning each referenced
 * extraction site exactly once into `sites`.
 */
export class ProvenanceSummariser {
  readonly sites: Record<string, ExtractSiteSummary> = {};

  summariseTrail(provenance: Provenance | undefined): SummarisedOrigin[] {
    return (provenance?.origins ?? []).map((origin) => this.summariseOrigin(origin));
  }

  private summariseOrigin(origin: ProvenanceOrigin): SummarisedOrigin {
    switch (origin.kind) {
      case 'extraction': {
        return {
          kind: 'extraction',
          site: this.internSite(origin.site),
          ...(origin.field !== undefined ? { field: origin.field } : {}),
          ...(origin.description !== undefined ? { description: origin.description } : {}),
          ...(origin.quote !== undefined ? { quote: origin.quote } : {}),
        };
      }
      case 'write':
        return {
          kind: 'write',
          write: origin.writeIndex,
          ...(origin.externalId !== undefined ? { externalId: origin.externalId } : {}),
          ...(origin.field !== undefined ? { field: origin.field } : {}),
        };
      case 'ai':
        return { kind: 'ai', prompt: origin.prompt };
      case 'source_field':
      case 'resource':
      case 'enrichment':
      case 'file':
      case 'literal':
      case 'meta':
        return { ...origin };
    }
  }

  private internSite(site: ExtractSiteRef): string {
    if (!(site.siteId in this.sites)) {
      // Reserve the slot before summarising data sources — a site whose
      // data sources somehow referenced itself would terminate.
      this.sites[site.siteId] = {
        node: site.node,
        description: site.description,
        stage: site.stage,
        dataSources: [],
      };
      this.sites[site.siteId].dataSources = site.dataSources.map((origin) =>
        this.summariseOrigin(origin),
      );
    }
    return site.siteId;
  }
}
