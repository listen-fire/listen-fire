// A compact, readable account of what one automation run did, projected from
// the run inspector's response (writes, decision trace, errors). It exists so a
// failed fixture can be diagnosed from the trial JSON alone, without the
// loop log. Every list is capped; a cap is stated, never silent.

const MAX_WRITES = 20;
const MAX_EXTRACTIONS = 8;
const MAX_ENTITIES_PER_ALIAS = 6;
const MAX_MESSAGES = 5;
const MAX_FIELDS = 8;
const MAX_TEXT = 100;

interface WriteSummary {
  system: string;
  recordType: string;
  /** created | updated | skipped, or the raw action for link/unlink/delete/match. */
  outcome: string;
  committed: boolean;
  values: Record<string, string>;
}

interface ExtractionSummary {
  node: string | null;
  skipped?: string;
  failed?: string;
  /** Per node alias, the extracted entities' fields (null = came back absent). */
  entities: Record<string, Array<Record<string, string | null>>>;
}

interface RunTraceSummary {
  writes: WriteSummary[];
  writesOmitted: number;
  extractions: ExtractionSummary[];
  extractionsOmitted: number;
  /** Gates and `if` branches that evaluated false and so did not run their body. */
  branchesNotTaken: number;
  warnings: string[];
  errors: string[];
}

type RunRecord = {
  id: string;
  status: string;
  failureReason: string | null;
} & (({ inspected: true } & RunTraceSummary) | { inspected: false; inspectError: string });

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clip(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function clipFields(values: Obj): Record<string, string> {
  return Object.fromEntries(Object.entries(values).slice(0, MAX_FIELDS).map(([k, v]) => [k, clip(v)]));
}

const WRITE_OUTCOMES: Record<string, string> = {
  create: 'created',
  update: 'updated',
  attach: 'updated',
  noop: 'skipped',
};

function summarizeWrite(write: Obj): WriteSummary {
  const target = typeof write.target === 'string' ? write.target : '';
  const [system = '', ...rest] = target.split(':');
  const action = typeof write.action === 'string' ? write.action : 'unknown';
  return {
    system,
    recordType: rest.join(':'),
    outcome: WRITE_OUTCOMES[action] ?? action,
    committed: write.committed === true,
    values: isObj(write.values) ? clipFields(write.values) : {},
  };
}

function summarizeExtraction(entry: Obj): ExtractionSummary {
  const entities: ExtractionSummary['entities'] = {};
  if (isObj(entry.entities)) {
    for (const [alias, list] of Object.entries(entry.entities)) {
      if (!Array.isArray(list)) continue;
      entities[alias] = list
        .filter(isObj)
        .slice(0, MAX_ENTITIES_PER_ALIAS)
        .map((entity) => {
          const fields = isObj(entity.fields) ? entity.fields : {};
          return Object.fromEntries(
            Object.entries(fields)
              .slice(0, MAX_FIELDS)
              .map(([k, v]): [string, string | null] => [k, v === null ? null : clip(v)]),
          );
        });
    }
  }
  return {
    node: typeof entry.node === 'string' ? entry.node : null,
    ...(typeof entry.skipped === 'string' ? { skipped: entry.skipped } : {}),
    ...(typeof entry.failed === 'string' ? { failed: entry.failed } : {}),
    entities,
  };
}

/** Project a run inspection (the inspect-run response body) into the compact trace summary. */
function summarizeInspection(inspection: unknown): RunTraceSummary | null {
  if (!isObj(inspection) || typeof inspection.error === 'string') return null;
  const writes = (Array.isArray(inspection.writes) ? inspection.writes : []).filter(isObj);
  const trace = (Array.isArray(inspection.trace) ? inspection.trace : []).filter(isObj);
  const errors = Array.isArray(inspection.errors) ? inspection.errors : [];
  const extractions = trace.filter((e) => e.kind === 'extraction');
  return {
    writes: writes.slice(0, MAX_WRITES).map(summarizeWrite),
    writesOmitted: Math.max(0, writes.length - MAX_WRITES),
    extractions: extractions.slice(0, MAX_EXTRACTIONS).map(summarizeExtraction),
    extractionsOmitted: Math.max(0, extractions.length - MAX_EXTRACTIONS),
    branchesNotTaken: trace.filter((e) => e.kind === 'gate' && e.outcome === false).length,
    warnings: trace
      .filter((e) => e.kind === 'warning')
      .slice(0, MAX_MESSAGES)
      .map((e) => clip(`${String(e.code ?? '')}: ${String(e.message ?? '')}`)),
    errors: errors
      .slice(0, MAX_MESSAGES)
      .map((e) => clip(isObj(e) && typeof e.message === 'string' ? e.message : e)),
  };
}

function runRecordOf(
  run: { id: string; status: string; failureReason: string | null },
  inspected: { body: unknown } | { error: string },
): RunRecord {
  const base = { id: run.id, status: run.status, failureReason: run.failureReason };
  if ('error' in inspected) return { ...base, inspected: false, inspectError: inspected.error };
  const summary = summarizeInspection(inspected.body);
  return summary
    ? { ...base, inspected: true, ...summary }
    : { ...base, inspected: false, inspectError: `unreadable inspection: ${clip(inspected.body)}` };
}

export { runRecordOf, summarizeInspection };
export type { ExtractionSummary, RunRecord, RunTraceSummary, WriteSummary };
