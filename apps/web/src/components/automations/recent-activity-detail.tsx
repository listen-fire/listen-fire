"use client";

// Inline detail for a single Recent-activity entry on the automation detail
// page. Lazily loads the firing (only when its row is expanded) and renders
// what it wrote — one block per applied record, created/updated, with the
// written field values. Reconstructed from the firing's flattened applied
// action plans (the union across the firing's orchestration steps — the same
// data a dry-run preview shows), so a past firing reads like a preview.

import { useState } from "react";

import { trpc } from "@/lib/trpc";

interface AppliedPlan {
  nodeId: string;
  adapterType: string;
  recordType: string;
  created: boolean;
  /** False when the run REHEARSED this write — the effect was captured, never
   *  sent. A rehearsal that read like a completed write was the whole problem. */
  committed?: boolean;
  externalId?: string;
  /** What this record hangs off, and by which edge. A record with no parent
   *  shown reads as standing alone, which for an entry on a list is a
   *  different claim than the one the run made. */
  parents?: Array<{ recordType: string; externalId: string; edgeName: string }>;
  writtenValues?: Record<string, unknown>;
}

interface RunError {
  nodeId?: string;
  message: string;
}

/** The engine's decision-point trace (step.diagnostics.trace) — why the
 *  run did, or didn't do, each thing. Mirrors MovementTraceEntry. */
type TraceEntry =
  | { kind: "field_miss"; binding: string; field: string; available: string[] }
  | {
      kind: "extraction";
      node?: string;
      inputChars: number;
      skipped?: "empty_source" | "no_enrichment";
      /** What each lookup this reading waited on did — including one whose
       *  result went over the side with a reading that failed ("dropped"). */
      plugins?: Array<{ plugin: string; outcome: "skipped" | "empty" | "dropped" }>;
      /** The reading came back in a shape the automation doesn't describe,
       *  twice. Without `fallback`, the run stopped here. */
      failed?: "invalid_reply";
      /** Present with `failed` when the run carried on: the reading was
       *  refining one thing that had already been read, so it keeps what it
       *  had and this reading's own fields stay empty. */
      fallback?: "kept_previous_stage";
      /** Present when the reading had to be asked for a second time. */
      retried?: string[];
      /** Kept only when something went wrong: the keys the reading came
       *  back under, and the head of it. */
      reply?: { why: string[]; keys: string[]; sample: string };
      emissions: Record<string, number>;
      empty?: Record<string, number>;
      /** How many were thrown away for carrying no values. Runs recorded
       *  before this was counted separately only have `empty`. */
      dropped?: Record<string, number>;
      /** What was read out, by the name the automation gave it. A `null`
       *  value means the field came back with nothing — the case this
       *  view exists to make obvious. */
      entities?: Record<string, Array<{ fields: Record<string, string | null> }>>;
      /** Per name, how many more were read out than are listed above. */
      truncatedCount?: Record<string, number>;
    }
  | {
      kind: "plugin";
      plugin: string;
      node: string;
      url?: string;
      durationMs: number;
      chars?: number;
      fields?: string[];
      /** Set when it didn't run: the argument that had nothing in it. */
      skippedParam?: string;
    }
  | { kind: "ai"; prompt: string; hasValue: boolean }
  | { kind: "gate"; outcome: boolean }
  | { kind: "block"; root: string; positions: number };

function traceOf(steps: unknown): TraceEntry[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) => {
    const trace = (step as { diagnostics?: { trace?: unknown } })?.diagnostics
      ?.trace;
    return Array.isArray(trace) ? (trace as TraceEntry[]) : [];
  });
}

/** Warnings explain a quiet run; informational entries narrate it. */
function traceSeverity(entry: TraceEntry): "warn" | "info" {
  if (entry.kind === "field_miss") return "warn";
  if (entry.kind === "plugin") return entry.skippedParam ? "warn" : "info";
  if (entry.kind === "extraction") {
    // Not reading again for want of anything new is the engine working, not a
    // problem — the lookup that found nothing warns on its own line.
    if (entry.skipped === "no_enrichment") return "info";
    if (entry.skipped || entry.failed || entry.retried) return "warn";
    const discarded = entry.dropped ?? entry.empty;
    if (discarded && Object.keys(discarded).length > 0) return "warn";
  }
  return "info";
}

function describeTraceEntry(entry: TraceEntry): string {
  switch (entry.kind) {
    case "field_miss":
      return `Read ${entry.binding}.${entry.field}, but this event has no “${entry.field}” — it carries: ${entry.available.join(", ")}`;
    case "extraction": {
      if (entry.skipped === "empty_source") {
        return "Extraction skipped — its source text was empty.";
      }
      if (entry.skipped === "no_enrichment") {
        const lookups = entry.plugins?.map((p) => p.plugin).join(", ");
        return `Didn’t read ${prettyAlias(entry.node ?? "")} again — ${lookups ? `${lookups} found` : "the lookups found"} nothing new for it.`;
      }
      if (entry.failed === "invalid_reply") {
        const under = entry.reply?.keys.length
          ? ` It answered under ${entry.reply.keys.join(", ")} instead.`
          : "";
        const kept =
          entry.fallback === "kept_previous_stage"
            ? " Kept what had already been read for it and carried on."
            : "";
        return `Reading ${prettyAlias(entry.node ?? "")} came back in a shape this automation doesn’t describe, twice.${under}${kept}`;
      }
      const yields = Object.entries(entry.emissions)
        .filter(([name]) => name !== "extract result")
        .map(([name, count]) => {
          const discarded = entry.dropped?.[name] ?? entry.empty?.[name];
          return discarded
            ? `${name}: ${count} (${discarded} with no values — dropped)`
            : `${name}: ${count}`;
        })
        .join(", ");
      const askedAgain = entry.retried ? " — asked again after an unusable answer" : "";
      return `Extraction over ${entry.inputChars.toLocaleString()} characters${yields ? ` → ${yields}` : ""}${askedAgain}`;
    }
    case "plugin": {
      if (entry.skippedParam) {
        return `${entry.plugin} didn’t run on ${prettyAlias(entry.node)} — its “${entry.skippedParam}” was empty.`;
      }
      const took =
        entry.durationMs >= 1000 ? ` in ${Math.round(entry.durationMs / 1000)}s` : "";
      const got = entry.chars
        ? `, ${entry.chars.toLocaleString()} characters back`
        : entry.fields?.length
          ? `, added ${entry.fields.join(", ")}`
          : "";
      return `${entry.plugin} ran on ${prettyAlias(entry.node)}${entry.url ? ` (${entry.url})` : ""}${took}${got}`;
    }
    case "ai": {
      const prompt =
        entry.prompt.length > 80 ? `${entry.prompt.slice(0, 80)}…` : entry.prompt;
      return entry.hasValue
        ? `AI(“${prompt}”) produced a value`
        : `AI(“${prompt}”) decided nothing applies (no value)`;
    }
    case "gate":
      return entry.outcome
        ? "A condition matched — its block ran."
        : "A condition didn’t match — its block was skipped.";
    case "block":
      return `${entry.root} ran over ${entry.positions} item${entry.positions === 1 ? "" : "s"}`;
  }
}

/** The extract's own root has no author-given name — say what it is. */
function prettyAlias(name: string): string {
  return name === "extract result" ? "Overall" : name;
}

/** One line of the run's account of itself. An extraction line that
 *  captured what it read opens up into the values, so a field that came
 *  back empty is visible here instead of only in the database. */
function TraceLine({ entry }: { entry: TraceEntry }) {
  const [open, setOpen] = useState(false);
  const warn = traceSeverity(entry) === "warn";
  const tone = warn ? "text-amber-700" : "text-gray-600";
  const detail =
    entry.kind === "extraction" &&
    entry.entities &&
    Object.keys(entry.entities).length > 0
      ? { entities: entry.entities, truncated: entry.truncatedCount }
      : undefined;

  if (!detail) {
    return (
      <li className={`text-[11px] leading-relaxed ${tone}`}>
        {warn ? "⚠ " : ""}
        {describeTraceEntry(entry)}
      </li>
    );
  }

  return (
    <li className="text-[11px] leading-relaxed">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className={`flex w-full items-start gap-1 text-left ${tone} hover:underline`}
      >
        <span className="shrink-0 text-gray-400">{open ? "▾" : "▸"}</span>
        <span>
          {warn ? "⚠ " : ""}
          {describeTraceEntry(entry)}
        </span>
      </button>
      {open && (
        <ExtractedEntities
          entities={detail.entities}
          truncated={detail.truncated}
        />
      )}
    </li>
  );
}

function ExtractedEntities({
  entities,
  truncated,
}: {
  entities: Record<string, Array<{ fields: Record<string, string | null> }>>;
  truncated?: Record<string, number>;
}) {
  return (
    <div className="mt-1.5 space-y-2 border-l-2 border-gray-100 pl-2.5">
      {Object.entries(entities).map(([name, list]) => (
        <div key={name}>
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            {prettyAlias(name)}
          </div>
          <div className="space-y-1.5">
            {list.map((entity, i) => (
              <dl
                key={i}
                className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-0.5 rounded border border-gray-100 bg-gray-50/60 px-2 py-1.5"
              >
                {Object.entries(entity.fields).map(([field, value]) => (
                  <div key={field} className="contents">
                    <dt className="truncate text-[11px] text-gray-500">
                      {field}
                    </dt>
                    <dd
                      className={`min-w-0 break-words text-[11px] ${
                        value === null
                          ? "italic text-gray-400"
                          : "text-gray-800"
                      }`}
                    >
                      {value === null ? "nothing found" : value}
                    </dd>
                  </div>
                ))}
              </dl>
            ))}
          </div>
          {truncated?.[name] ? (
            <div className="mt-1 text-[10px] text-gray-400">
              {truncated[name]} more not shown here.
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map((v) => renderValue(v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Strip an adapter prefix ("attio:companies" → "companies") for a cleaner
 *  label, then title-case. Falls back to the raw type when there's no prefix. */
function prettyRecordType(recordType: string): string {
  const tail = recordType.includes(":")
    ? recordType.slice(recordType.indexOf(":") + 1)
    : recordType;
  return tail
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function RecentActivityDetail({ runId }: { runId: string }) {
  const { data, isLoading, error } =
    trpc.views.credentials.getTgRun.useQuery({ runId });

  if (isLoading) {
    return (
      <div className="px-4 py-3 text-[12px] text-gray-400">Loading run…</div>
    );
  }
  if (error || !data) {
    return (
      <div className="px-4 py-3 text-[12px] text-red-500">
        Couldn’t load this run{error ? `: ${error.message}` : ""}.
      </div>
    );
  }

  const plans = (
    Array.isArray(data.appliedActionPlans) ? data.appliedActionPlans : []
  ) as AppliedPlan[];
  const errors = (Array.isArray(data.errors) ? data.errors : []) as RunError[];
  const trace = traceOf(data.steps);

  return (
    <div className="space-y-2 border-t border-gray-100 bg-gray-50/50 px-4 py-3">
      {/* Which saved version this run used — a run that fired before the
          last save did NOT use what the editor shows today. */}
      {data.executedVersion && (
        <div className="text-[11px] text-gray-400">
          Version {data.executedVersion.number}
          {!data.executedVersion.isCurrent && (
            <span className="ml-1 text-amber-700">
              · older than the current version (
              {data.executedVersion.currentNumber})
            </span>
          )}
        </div>
      )}

      {data.failure_reason && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {data.failure_reason}
        </div>
      )}

      {/* The run's own account of what it decided — the answer to
          "processed, but nothing was written… why?". */}
      {trace.length > 0 && (
        <div className="rounded-md border border-gray-200 bg-white px-3 py-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-gray-400">
            What happened
          </div>
          <ul className="space-y-0.5">
            {trace.map((entry, i) => (
              <TraceLine key={i} entry={entry} />
            ))}
          </ul>
        </div>
      )}

      {plans.length === 0 && errors.length === 0 && !data.failure_reason ? (
        trace.length === 0 ? (
          <div className="text-[12px] text-gray-400">
            This run made no changes.
          </div>
        ) : null
      ) : (
        plans.map((plan, i) => {
          const fields = Object.entries(plan.writtenValues ?? {});
          return (
            <div
              key={`${plan.nodeId}-${i}`}
              className="rounded-md border border-gray-200 bg-white px-3 py-2"
            >
              <div className="mb-1 flex items-center gap-2">
                <span
                  className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    plan.created
                      ? "bg-emerald-50 text-emerald-600"
                      : "bg-blue-50 text-blue-600"
                  }`}
                >
                  {plan.created ? "Created" : "Updated"}
                </span>
                <span className="text-[12px] font-medium text-gray-800">
                  {prettyRecordType(plan.recordType)}
                </span>
                {plan.committed === false && (
                  <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                    Rehearsed
                  </span>
                )}
              </div>
              {/* An entry added to a list is not the same claim as an entry:
                  say what it attached to, and by which edge. */}
              {(plan.parents ?? []).length > 0 && (
                <div className="mb-1 text-[11px] text-gray-500">
                  {(plan.parents ?? [])
                    .map(
                      (parent) =>
                        `on ${prettyRecordType(parent.recordType)} via ${parent.edgeName}`,
                    )
                    .join(" · ")}
                </div>
              )}
              {fields.length === 0 ? (
                <div className="text-[11px] text-gray-400">No fields written.</div>
              ) : (
                <dl className="grid grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-0.5">
                  {fields.map(([field, value]) => (
                    <div key={field} className="contents">
                      <dt className="truncate text-[11px] text-gray-500">
                        {field}
                      </dt>
                      <dd className="min-w-0 break-words text-[11px] text-gray-800">
                        {renderValue(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </div>
          );
        })
      )}

      {errors.length > 0 && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-600">
            Heads up
          </div>
          <ul className="space-y-0.5">
            {errors.map((e, i) => (
              <li key={i} className="text-[11px] text-amber-700">
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
