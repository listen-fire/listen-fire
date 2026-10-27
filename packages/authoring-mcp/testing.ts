// A host that keeps everything in memory, for tests of this package and of a
// host's own wiring: a program store with the revision rule, runs a test
// scripts, and tenants told apart by a bearer token.

import type { IncomingMessage } from 'node:http';

import type {
  AuthoringHost,
  ProgramSaved,
  ProgramStore,
  ProgramWrite,
  RunSource,
  RunTrace,
  RunView,
  StoredProgram,
  TenantCatalog,
  TenantHost,
} from './host';
import { revisionOf } from './text';

/** A program store in one process. A write and its revision check happen in
 *  one synchronous step, so no other write can come between them. */
export function memoryProgramStore(options: { now?: () => Date } = {}): ProgramStore & { saved: Map<string, StoredProgram> } {
  const now = options.now ?? (() => new Date());
  const saved = new Map<string, StoredProgram>();
  let next = 1;
  const save = (write: ProgramWrite): ProgramSaved => {
    const current = write.id !== undefined ? saved.get(write.id) : undefined;
    if (write.id !== undefined && current === undefined) return { ok: false, error: `No automation '${write.id}'.` };
    if (current !== undefined && write.expectedRevision !== undefined && revisionOf(current.source) !== write.expectedRevision) {
      return { ok: false, conflict: current };
    }
    const clash = [...saved.values()].find((p) => p.name === write.name && p.id !== write.id);
    if (clash !== undefined) return { ok: false, error: `An automation is already named '${write.name}'.` };
    const program: StoredProgram = {
      id: current?.id ?? `automation-${next++}`,
      name: write.name,
      ...(write.description !== undefined ? { description: write.description } : {}),
      source: write.source,
      updatedAt: now().toISOString(),
    };
    saved.set(program.id, program);
    return { ok: true, program };
  };
  return {
    saved,
    list: async () => [...saved.values()],
    get: async (ref) => ('id' in ref ? (saved.get(ref.id) ?? null) : ([...saved.values()].find((p) => p.name === ref.name) ?? null)),
    save: async (write) => save(write),
    delete: async (id) => saved.delete(id),
  };
}

/** Runs a test decides: each start records a run that `outcome` settles. */
export function scriptedRuns(outcome: (input: { program: StoredProgram; text?: string }) => Omit<RunTrace, 'runId'>): RunSource & { traces: Map<string, RunTrace> } {
  const traces = new Map<string, RunTrace>();
  const byRequest = new Map<string, string>();
  const byProgram = new Map<string, string[]>();
  const view = ({ event: _event, writes: _writes, decisions: _decisions, errors: _errors, ...rest }: RunTrace): RunView => rest;
  return {
    traces,
    async start(input) {
      const replayed = input.requestId !== undefined ? byRequest.get(input.requestId) : undefined;
      const known = replayed !== undefined ? traces.get(replayed) : undefined;
      if (known !== undefined) return { ok: true, runId: known.runId, status: known.status };
      const runId = `run-${traces.size + 1}`;
      const trace: RunTrace = { runId, ...outcome({ program: input.program, ...(input.text !== undefined ? { text: input.text } : {}) }) };
      traces.set(runId, trace);
      if (input.requestId !== undefined) byRequest.set(input.requestId, runId);
      byProgram.set(input.program.id, [runId, ...(byProgram.get(input.program.id) ?? [])]);
      return { ok: true, runId, status: trace.status };
    },
    status: async (runId) => {
      const trace = traces.get(runId);
      return trace === undefined ? null : view(trace);
    },
    list: async (program, { limit }) => (byProgram.get(program.id) ?? []).slice(0, limit).flatMap((runId) => {
      const trace = traces.get(runId);
      return trace === undefined ? [] : [view(trace)];
    }),
    trace: async (runId) => traces.get(runId) ?? null,
  };
}

/** One tenant's in-memory host over a fixed catalog. */
export function memoryTenantHost(input: { catalog: TenantCatalog; runs?: RunSource; now?: () => Date }): TenantHost & {
  programs: ReturnType<typeof memoryProgramStore>;
} {
  return {
    catalog: async () => input.catalog,
    programs: memoryProgramStore(input.now !== undefined ? { now: input.now } : {}),
    ...(input.runs !== undefined ? { runs: input.runs } : {}),
  };
}

/** Tenants by bearer token: a request with none, or an unknown one, is refused. */
export function memoryAuthoringHost<T extends TenantHost>(input: { tenants: Record<string, T> } & Omit<AuthoringHost<T>, 'tenant'>): AuthoringHost<T> {
  const { tenants, ...rest } = input;
  return {
    ...rest,
    tenant: async (request: IncomingMessage) => {
      const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1];
      const tenant = token !== undefined ? tenants[token] : undefined;
      return tenant !== undefined ? { ok: true, tenant } : { ok: false, status: 401, message: 'no tenant for this request' };
    },
  };
}
