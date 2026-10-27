// What a host supplies so this package can serve the authoring tools for one
// of its tenants. The host owns auth, storage and runs; the package owns the
// language half: the handbook, its search, the checker, the digest of
// connected systems, and the rules every save follows (check first, refuse
// what would not go live, refuse a stale revision).
//
// Every function a tenant's host carries answers for that tenant alone: the
// host's `tenant` function hands the package one tenant's functions per
// request, so the package has no way to name another.

import type { IncomingMessage } from 'node:http';

import type { Chapter, PluginChapterId, SystemChapterId } from '@listen-fire/handbook';
import type { FileListener } from 'movement-engine/public/inbound';
import type { CatalogSnapshot, Diagnostic } from 'movement-lang';
import type { ZodRawShape } from 'zod';

/** A value that survives JSON: what a host hands back for the agent to read. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

// ── Programs ────────────────────────────────────────────────────────────────

/** One saved automation, as the host keeps it. */
export interface StoredProgram {
  id: string;
  /** Unique within the tenant: the agent may name a program instead of giving its id. */
  name: string;
  description?: string;
  /** The program text. */
  source: string;
  /** When it last changed, ISO 8601. */
  updatedAt: string;
}

export type ProgramRef = { id: string } | { name: string };

/** A save the package has already checked (or the agent saved with consent). */
export interface ProgramWrite {
  /** The program to replace. Absent: a new one. */
  id?: string;
  name: string;
  description?: string;
  source: string;
  /**
   * The revision the agent last read (`revisionOf` of the text it saw).
   * Present: the host compares it with `revisionOf(stored.source)` in the
   * same atomic step as the write, and refuses with the stored program when
   * they differ. Absent: the write goes ahead whatever is stored.
   */
  expectedRevision?: string;
  /** The listens the text declares, read by the package, so the host can
   *  route events without parsing the text. Empty when the text does not
   *  parse (saved only with the agent's consent). */
  listeners: FileListener[];
}

export type ProgramSaved =
  /** `warnings`: what saved fine but would surprise the user, said to them.
   *  `link`: a page that shows the user the automation. */
  | { ok: true; program: StoredProgram; warnings?: string[]; link?: string }
  /** The revision moved: nothing was written; `current` is what is stored. */
  | { ok: false; conflict: StoredProgram }
  /** Refused for a reason of the host's (no program with that id, a name in use). */
  | { ok: false; error: string };

export interface ProgramStore {
  list(): Promise<StoredProgram[]>;
  get(ref: ProgramRef): Promise<StoredProgram | null>;
  save(write: ProgramWrite): Promise<ProgramSaved>;
  /** False when no program has that id. */
  delete(id: string): Promise<boolean>;
}

// ── The catalog ─────────────────────────────────────────────────────────────

/** A tenant's catalog: what its programs are checked against. */
export interface TenantCatalog {
  /** What `buildCatalogSnapshot` returns (docs/embedding.md). */
  snapshot: CatalogSnapshot;
  /** Each connection by the name a program imports it by, with the system
   *  (adapter type) it serves. */
  connections: Array<{ name: string; system: string }>;
}

/** `fresh`: read the systems again rather than serve a cached copy, so a
 *  field the user has just added shows (describeConnection asks for it). */
export type CatalogSource = (options: { fresh: boolean }) => Promise<TenantCatalog>;

// ── Optional: the check ─────────────────────────────────────────────────────

export interface CheckRequest {
  source: string;
  catalog: CatalogSnapshot;
  /** The saved program the text belongs to, when it is a change to one. */
  program?: StoredProgram;
}

export interface CheckResult {
  /** Every diagnostic: errors, warnings and info. */
  diagnostics: Diagnostic[];
  /** Nothing blocks: a save would go live. */
  ok: boolean;
  /** Systems the text uses that could not be checked, each with why. A save
   *  refuses while there are any, unless the agent has the user's consent. */
  unverified?: string[];
  /** The language version the text was checked under. */
  version: string;
}

/** Replaces the package's checker (`checkProgram`, this release's language). */
export type ProgramChecker = (request: CheckRequest) => Promise<CheckResult>;

// ── Optional: a deeper describe ─────────────────────────────────────────────

export interface DescribeRequest {
  system: string;
  connection?: string;
  /** Where to stand: a position a previous answer handed back. */
  position?: string;
  types?: string[];
  detail: 'compact' | 'full';
}

/** Answered from live adapter calls; `null` falls back to the snapshot. */
export type DeeperDescribe = (request: DescribeRequest) => Promise<{ text: string } | { json: JsonValue } | null>;

// ── Optional: runs ──────────────────────────────────────────────────────────

/** `running` until it settles; `parked` waits on something (a timer, a person). */
export type RunStatus = 'running' | 'parked' | 'success' | 'partial' | 'failed';

export interface RunFile {
  filename: string;
  contentType: string;
  contentBase64: string;
}

export type RunStarted = { ok: true; runId: string; status: RunStatus } | { ok: false; error: string };

/** One run's state, as checkRun answers it. */
export interface RunView {
  runId: string;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  failureReason?: string;
  /** How many records it wrote. */
  recordCount?: number;
  /** Its model-call spend, in dollars. */
  costUsd?: number;
  modelCalls?: number;
}

/** What a run did: the event that fired it, its writes, and its decisions. */
export interface RunTrace extends RunView {
  event: JsonValue;
  writes: JsonValue[];
  decisions: JsonValue[];
  errors: string[];
}

export interface RunSource {
  /** Start a run of `program` on `text` and/or `files`. A retry carrying the
   *  same `requestId` answers with the first run rather than a second. */
  start(input: { program: StoredProgram; text?: string; files?: RunFile[]; requestId?: string }): Promise<RunStarted>;
  status(runId: string): Promise<RunView | null>;
  /** Newest first. */
  list(program: StoredProgram, options: { limit: number }): Promise<RunView[]>;
  trace(runId: string): Promise<RunTrace | null>;
}

// ── One tenant's host ───────────────────────────────────────────────────────

export interface TenantHost {
  catalog: CatalogSource;
  programs: ProgramStore;
  /** Absent: runAutomation, checkRun, listRuns and inspectRun are not served. */
  runs?: RunSource;
  check?: ProgramChecker;
  describe?: DeeperDescribe;
}

/** What a tool answers: text (markdown), or a value sent as JSON. */
export type ToolAnswer = { text: string } | { json: JsonValue };

/** A tool of the host's own, served beside the package's. */
export interface HostTool<T extends TenantHost> {
  title: string;
  description: string;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean };
  inputSchema: ZodRawShape;
  /** `args` are validated against `inputSchema` before the call. */
  handler(args: Record<string, unknown>, tenant: T): Promise<ToolAnswer>;
}

export type TenantAccess<T extends TenantHost> =
  | { ok: true; tenant: T }
  /** The request is refused before any tool is listed. */
  | { ok: false; status: number; message: string };

export interface AuthoringHost<T extends TenantHost = TenantHost> {
  /** The host's own auth: which tenant this request acts for, or a refusal.
   *  Runs first, on every request. */
  tenant(request: IncomingMessage): Promise<TenantAccess<T>>;
  /** Handbook chapters for the host's own systems and plugins
   *  (`system:<adapter>`, `plugin:<name>`), read beside the language's. */
  chapters?: Readonly<Partial<Record<SystemChapterId | PluginChapterId, Chapter>>>;
  /** One more paragraph of the instructions a client is given on connect. */
  instructions?: string;
  /** Tools of the host's own, by name; a name the package serves is refused. */
  tools?: Readonly<Record<string, HostTool<T>>>;
}
