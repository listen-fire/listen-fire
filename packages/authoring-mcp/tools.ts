// The authoring tools: each one's name, description and input as the hosted
// product registers it (the builder skill and existing agents call them by
// these names), and what it does over one tenant's host. A description is
// reworded only where it named something only the hosted product has (teams,
// connect links, reviews, story links, older language versions).

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { LANGUAGE_SEARCH_KINDS } from '@listen-fire/handbook';
import type { FileListener } from 'movement-engine/public/inbound';
import { z } from 'zod';

import { checkProgram, listenersOf, unsavedRefusal, validationOf, type AuthoringDiagnostic } from './check';
import { connectionsView, describeFromSnapshot, describeFull, renderConnectionsDigest } from './digest';
import { readHandbook, searchHandbook, type HostChapters } from './handbook';
import type { JsonValue, StoredProgram, TenantHost, ToolAnswer } from './host';
import { renderFrontPage } from '@listen-fire/handbook';
import { applyContentEdit, grepPrograms, readWindow, revisionOf } from './text';

/** Every tool the package serves, in the order a client lists them. */
export const AUTHORING_TOOL_NAMES = [
  'getStarted',
  'readHandbook',
  'searchLanguage',
  'listConnections',
  'describeConnection',
  'validateAutomation',
  'saveAutomation',
  'deleteAutomation',
  'listAutomations',
  'getAutomation',
  'readAutomation',
  'editAutomation',
  'grepAutomations',
] as const;

/** Served only when the host supplies runs. */
export const RUN_TOOL_NAMES = ['runAutomation', 'checkRun', 'listRuns', 'inspectRun'] as const;

export type AuthoringToolName = (typeof AUTHORING_TOOL_NAMES)[number] | (typeof RUN_TOOL_NAMES)[number];

/** What a client is told on connect: reference only, never how to talk to
 *  the user (that is the builder skill's). */
export function authoringInstructions(options: { runs: boolean; extra?: string }): string {
  const runs = options.runs ? ' Then runAutomation on real input; checkRun and inspectRun show what a run did.' : '';
  return (
    'To automate anything for the user — react to events, move data between their systems — build an "automation" here: a small program over their real connected systems.\n\n' +
    'The loop. Call getStarted first: one call returns the handbook\'s front page (where this language differs from TypeScript, the few ideas it adds, the build loop) and the connected systems with their record types and fields. The handbook\'s chapters are not needed: look up anything else — a built-in\'s signature, a system\'s behaviour, a recipe — with searchLanguage, and read the anchor a result or a diagnostic names with readHandbook ("front#maybe-absent"); where anything else disagrees with the handbook, the handbook wins. ' +
    'Author against the real record and field names (getStarted\'s digest; describeConnection for more of one system), never from memory. Then saveAutomation: it validates first and saves nothing while there are errors, handing back the diagnostics, so a separate validateAutomation is not needed.' +
    runs +
    ' Make independent tool calls together, in one turn. Once something is saved, prefer a small edit over resending the whole program: readAutomation (or getAutomation, which also carries its metadata) to see the current text, grepAutomations to find where something is defined or used, and editAutomation to change it — anchored on a unique snippet plus the revision you just read, so a concurrent edit is caught instead of clobbered. Reach for saveAutomation itself only for a brand-new automation or a genuine rewrite. A write a third party sees (an email, a message to someone else) gets an approval step inside the automation — a question a person acts on.' +
    (options.extra !== undefined && options.extra !== '' ? `\n\n${options.extra}` : '')
  );
}

/** One tenant's host as the tools reach it. */
export interface ToolContext {
  tenant: TenantHost;
  chapters: HostChapters;
}

export function toolResult(answer: ToolAnswer): CallToolResult {
  if ('text' in answer) return { content: [{ type: 'text', text: answer.text }] };
  const refused = answer.json !== null && typeof answer.json === 'object' && !Array.isArray(answer.json) && 'error' in answer.json;
  return { content: [{ type: 'text', text: JSON.stringify(answer.json) }], ...(refused ? { isError: true } : {}) };
}

const json = (value: unknown): CallToolResult => toolResult({ json: toJson(value) });
const text = (value: string): CallToolResult => toolResult({ text: value });
const refuse = (error: string): CallToolResult => json({ error });

/** A value as JSON carries it: `undefined` fields dropped. */
function toJson(value: unknown): JsonValue {
  const round: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return round;
}

/** By id first, then by exact name. */
async function resolveProgram(tenant: TenantHost, idOrName: string): Promise<StoredProgram | null> {
  return (await tenant.programs.get({ id: idOrName })) ?? (await tenant.programs.get({ name: idOrName }));
}

const notFound = (idOrName: string) => refuse(`No automation '${idOrName}'.`);

function listensOf(listeners: readonly FileListener[]) {
  return listeners.map((l) => ({
    system: l.adapter,
    movement: l.movementName,
    ...(l.credentialName !== undefined ? { connection: l.credentialName } : {}),
    ...(l.alias !== undefined ? { lane: l.alias } : {}),
    ...(Object.keys(l.config).length > 0 ? { config: l.config } : {}),
  }));
}

function programView(program: StoredProgram) {
  return {
    id: program.id,
    name: program.name,
    ...(program.description !== undefined ? { description: program.description } : {}),
    updatedAt: program.updatedAt,
    revision: revisionOf(program.source),
    listeners: listensOf(listenersOf(program.source) ?? []),
  };
}

/**
 * A save as saveAutomation and editAutomation make it: checked first, refused
 * while it would not go live (unless the agent has the user's consent), then
 * written by the host under the revision the agent read.
 */
async function saveChecked(
  tenant: TenantHost,
  input: {
    source: string;
    existing?: StoredProgram;
    name?: string;
    description?: string;
    acknowledgeErrors?: boolean;
    expectedRevision?: string;
  },
): Promise<CallToolResult> {
  const name = input.name ?? input.existing?.name;
  if (name === undefined || name.trim() === '') return refuse('Pass a name for a new automation.');
  let remaining: AuthoringDiagnostic[] = [];
  if (input.acknowledgeErrors !== true) {
    const { snapshot } = await tenant.catalog({ fresh: false });
    const check = tenant.check ?? checkProgram;
    const result = await check({ source: input.source, catalog: snapshot, ...(input.existing !== undefined ? { program: input.existing } : {}) });
    const validation = validationOf(input.source, result);
    const refusal = unsavedRefusal(result, validation);
    if (refusal !== null) return json(refusal);
    remaining = validation.diagnostics;
  }
  const listeners = listenersOf(input.source);
  const warnings: string[] =
    listeners === null ? ['The text does not parse, so it declares no listens: it will not fire until a readable text is saved.'] : [];
  const description = input.description ?? input.existing?.description;
  const saved = await tenant.programs.save({
    ...(input.existing !== undefined ? { id: input.existing.id } : {}),
    name,
    ...(description !== undefined ? { description } : {}),
    source: input.source,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
    listeners: listeners ?? [],
  });
  if (!saved.ok) {
    if ('error' in saved) return json({ ok: false, saved: false, error: saved.error });
    return json({
      ok: false,
      saved: false,
      conflict: true,
      message:
        'Not saved: someone saved a newer version since you read it. Read it again (getAutomation or readAutomation), merge your change, and save with the new revision.',
      current: { revision: revisionOf(saved.conflict.source), updatedAt: saved.conflict.updatedAt },
    });
  }
  return json({
    ok: true,
    saved: true,
    ...programView(saved.program),
    runnable: (listeners ?? []).some((l) => l.adapter === 'manual'),
    ...(saved.link !== undefined ? { link: saved.link } : {}),
    warnings: [...(saved.warnings ?? []), ...warnings],
    ...(remaining.length > 0 ? { diagnostics: remaining } : {}),
  });
}

const idOrName = z.string().describe('The automation id (from listAutomations) or its exact name.');

/** Register the package's tools for one tenant (the run tools only when it has runs). */
export function registerAuthoringTools(server: McpServer, ctx: ToolContext): void {
  const { tenant, chapters } = ctx;

  server.registerTool(
    'getStarted',
    {
      title: 'Get started',
      description:
        "START HERE, in one call: the automations handbook's front page and the connected systems — how to import and construct each, its record types with their fields (`!` required, `*` identifying), and what a listen on it may say. Enough to write a first automation: describeConnection goes deeper on one system, searchLanguage answers a lookup.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => {
      const catalog = await tenant.catalog({ fresh: false });
      return text(['## Systems', renderConnectionsDigest(catalog), EXTRACT_CACHE_TIP, renderFrontPage()].join('\n\n'));
    },
  );

  server.registerTool(
    'readHandbook',
    {
      title: 'Read the handbook',
      description:
        'getStarted already serves the automations handbook\'s front page; read here for an anchor a searchLanguage result or a diagnostic names ("front#maybe-absent", "writes#identity", "system:slack"). Look things up with searchLanguage rather than reading chapters: a whole hand-written chapter answers with a pointer to it, while its sections, system and plugin chapters, and the front page\'s sections read in full. No args → the handbook and its chapters. handbook → its front page. handbook + chapter (or chapters[]) → the bodies — go straight there when you know what you need; you don\'t have to list the shelf first.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        handbook: z.string().optional().describe('Handbook id: "automations" (call readHandbook with no arguments to list it).'),
        chapter: z.string().optional().describe('A single anchor: a section ("writes#identity", "front#maybe-absent") or a system\'s chapter ("system:slack").'),
        chapters: z.array(z.string()).optional().describe('Several anchors to read in one call, e.g. ["front#maybe-absent","writes#identity","system:slack"].'),
      },
    },
    async (input) => json(readHandbook(input, chapters)),
  );

  server.registerTool(
    'searchLanguage',
    {
      title: 'Search the automation language',
      description:
        'Look up the automation language: a built-in function (its signature, generated from the language itself), a concept, a recipe, or what a system or plugin documents. Ask in words ("join text", "update or create a record", "wait for an approval") or by name ("COALESCE"). Returns a few entries, each with its purpose, signature or short text, an example, and an anchor to read in full with readHandbook.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        query: z.string().min(1).describe('What you need, in words or by name.'),
        kind: z.enum(LANGUAGE_SEARCH_KINDS).optional().describe('Only this kind: "function", "concept" or "recipe".'),
      },
    },
    async ({ query, kind }) => json(searchHandbook({ query, ...(kind !== undefined ? { kind } : {}) }, chapters)),
  );

  server.registerTool(
    'listConnections',
    {
      title: 'List connected systems',
      description:
        "The connected systems list: the systems a program may import (with construction args + listener-config keys), the connections by the names a program imports them by, and plugins. These are the ONLY names valid in automation imports and constructions — never invent one. A system marked `connected: false` needs a connection the user has not made yet. Where a system carries `triggerExpectation`, that is the plain-language truth about WHICH events a listener on it actually fires on — ground every trigger-surface claim you make to the user in it rather than guessing. Call describeConnection for a system's field schema before authoring against it.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => json(connectionsView(await tenant.catalog({ fresh: false }))),
  );

  server.registerTool(
    'describeConnection',
    {
      title: 'Describe a connected system',
      description:
        "The live shape of one connected system, ONE PLACE AT A TIME, as compact text in getStarted's notation. Every call re-reads the system's live schema, so it's safe to call again right after adding a field in the external workspace; the field names you write must match it exactly. Omit `position` and you stand at the system's ROOT: how to construct it, what a listen on it may say (its events and config keys), what it fires on, and every record type with its fields. Pass a `position` and you get that node's fields and every edge leaving it, each with the target's fields, one level deep — enough to author a read or write with no further call. Field marks: `!` required to create, `*` identifies the record (a `unique by` candidate), `~` read-only, `(write-only)` writable but never read back; a `backticked` name keeps its backticks in code; `enum(a|b|…+N)` lists the first options and counts the rest. `detail: \"full\"` returns the full JSON instead: the system's declarations and the raw schema — needed rarely, and many times larger. Also useful BEFORE anything is connected: the root still says what the system is and what a listen fires on — ground scope and capability claims to the user in these.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        system: z
          .union([z.string(), z.array(z.string())])
          .describe('The system name (from listConnections), e.g. "attio". Pass an array (e.g. ["slack","attio"]) to describe several systems in one call — preferred when your automation touches more than one.'),
        connection: z.string().optional().describe('Which connection to describe against (defaults to the system\'s first).'),
        types: z
          .array(z.string())
          .optional()
          .describe('Ask for these type names by name instead of walking to them. Rarely needed — prefer `position`, which is how the system tells you what exists.'),
        position: z
          .string()
          .optional()
          .describe(
            "WHERE TO STAND in the system. Omit it and you get the system's root: what it is, and every record type. Pass a position a previous answer showed you (it shows an example to copy) to get that place's fields and its edges. Only walk edges a previous call showed you.",
          ),
        detail: z
          .enum(['compact', 'full'])
          .optional()
          .describe('How much to say. Omit for the compact text (what you author against). "full" returns the JSON, at many times the size.'),
      },
    },
    async (input) => {
      const detail = input.detail ?? 'compact';
      const systems = Array.isArray(input.system) ? input.system : [input.system];
      // Scoping by connection, position or types is for one system at a time.
      const scoped = !Array.isArray(input.system);
      const catalog = await tenant.catalog({ fresh: true });
      const answers = await Promise.all(
        systems.map(async (system) => {
          const request = {
            system,
            ...(scoped && input.connection !== undefined ? { connection: input.connection } : {}),
            ...(scoped && input.position !== undefined ? { position: input.position } : {}),
            ...(scoped && input.types !== undefined ? { types: input.types } : {}),
          };
          const deeper = tenant.describe !== undefined ? await tenant.describe({ ...request, detail }) : null;
          if (deeper !== null) return deeper;
          if (detail === 'full') return { json: toJson(describeFull(catalog, request)) };
          const described = describeFromSnapshot(catalog, request);
          return described.ok ? { text: described.text } : { text: `Error: ${described.error}` };
        }),
      );
      if (detail === 'full') {
        const values = answers.map((a) => ('json' in a ? a.json : a.text));
        return json(Array.isArray(input.system) ? { connections: values } : values[0]);
      }
      return text(answers.map((a) => ('text' in a ? a.text : JSON.stringify(a.json))).join('\n\n'));
    },
  );

  server.registerTool(
    'validateAutomation',
    {
      title: 'Validate an automation',
      description:
        'Typecheck an automation program against the live connected systems WITHOUT saving: parse, check, and compile. Returns diagnostics (code, message, severity, line/col, offending line, and `handbook` — the anchor readHandbook serves that shows the fix, where there is one) and `validatedUnder` — `{ version }`, the language version it was checked against. A clean validation predicts a live save. saveAutomation runs this same check first and saves nothing on errors, so you need not call this before saving — use it to explore.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        source: z.string().describe('The automation program text (.mvt).'),
      },
    },
    async ({ source }) => {
      const { snapshot } = await tenant.catalog({ fresh: false });
      const result = await (tenant.check ?? checkProgram)({ source, catalog: snapshot });
      return json(validationOf(source, result));
    },
  );

  server.registerTool(
    'saveAutomation',
    {
      title: 'Save an automation',
      description:
        'Save an automation program and its listeners (authoring → live). It validates first, exactly as validateAutomation does, so there is no need to call that before: with any error, or a system it could not check, NOTHING is saved and you get { ok: false, saved: false, diagnostics } — fix them and save again. A clean save goes live. Pass acknowledgeErrors: true to ship it despite errors: it then replaces whatever was running (even broken) and will run and fail visibly. There is no "draft" that quietly keeps the last good version running — what goes live is what you save and confirm. When updating an EXISTING automation, pass expectedRevision so a concurrent edit is caught rather than silently overwritten. Returns its listeners, whether an on-demand run is possible (runnable), `revision`, `link` when the host offers a page that shows the user the automation (hand it out as a labelled link), `diagnostics` when a clean save still has warnings, and `warnings` — things that saved fine but would surprise the user. Always relay a warning to the user in your own words. Pass id to re-save/rename. For a small, targeted change to an existing automation — one line, one field — editAutomation is cheaper: it anchors the change on a snippet instead of resending the whole program.',
      annotations: { destructiveHint: true },
      inputSchema: {
        source: z.string().describe('The automation program text (.mvt).'),
        name: z.string().optional().describe('Human-readable display name (plain words, no underscores).'),
        description: z.string().optional().describe('Optional one-line description.'),
        id: z.string().optional().describe('Existing automation id when re-saving/renaming (from listAutomations).'),
        acknowledgeErrors: z
          .boolean()
          .optional()
          .describe(
            'Consent to ship an automation that has errors or cannot be verified. Without it, such a save is refused and nothing is saved. With it, the automation ships and replaces whatever was running (even broken), so it runs and fails visibly — only pass it once the user has agreed to that. If the source cannot even be READ (a syntax error), shipping it also retires every listener the automation had: it stops firing entirely until a readable source restores them, and the result says so in `warnings`.',
          ),
        expectedRevision: z
          .string()
          .optional()
          .describe(
            "The `revision` returned by your last getAutomation call for this automation. When updating an existing automation, pass it so a concurrent edit can't be silently overwritten — a mismatch (someone saved a newer version since) is rejected; call getAutomation again, merge, and re-save with the new revision. Omit to save regardless of what changed.",
          ),
      },
    },
    async (input) => {
      let existing: StoredProgram | undefined;
      if (input.id !== undefined) {
        const found = await tenant.programs.get({ id: input.id });
        if (found === null) return notFound(input.id);
        existing = found;
      }
      return saveChecked(tenant, {
        source: input.source,
        ...(existing !== undefined ? { existing } : {}),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.acknowledgeErrors !== undefined ? { acknowledgeErrors: input.acknowledgeErrors } : {}),
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      });
    },
  );

  server.registerTool(
    'deleteAutomation',
    {
      title: 'Delete an automation',
      description:
        'Permanently delete a saved automation and every listener it derives — a HARD delete: the automation and its run triggers are removed. There is no undo. Pass the automation id (from listAutomations). Returns { deleted } — false if no automation with that id exists.',
      annotations: { destructiveHint: true },
      inputSchema: {
        automation: z.string().describe('The automation id to delete (from listAutomations).'),
      },
    },
    async ({ automation }) => json({ deleted: await tenant.programs.delete(automation), automation }),
  );

  server.registerTool(
    'listAutomations',
    {
      title: 'List automations',
      description:
        "List the saved automations: each one's id, name, description, when it last changed, its `revision`, and its listeners. Use the id with getAutomation, saveAutomation, or runAutomation.",
      annotations: { readOnlyHint: true },
      inputSchema: {},
    },
    async () => json({ automations: (await tenant.programs.list()).map(programView) }),
  );

  server.registerTool(
    'getAutomation',
    {
      title: 'Get an automation',
      description:
        "Get one saved automation by its id or exact name: the full program text, its listeners, when it last changed, and `revision` — a fingerprint of its current source. When you only need the text (or part of it), readAutomation is cheaper; reach for this one when you also want the metadata alongside it. Re-read this or readAutomation (don't reuse an old copy) right before you edit and re-save an existing automation, and pass its `revision` back as saveAutomation's or editAutomation's expectedRevision — that way a concurrent edit by someone else is caught as a conflict instead of silently overwritten.",
      annotations: { readOnlyHint: true },
      inputSchema: { idOrName },
    },
    async (input) => {
      const program = await resolveProgram(tenant, input.idOrName);
      if (program === null) return notFound(input.idOrName);
      return json({ ...programView(program), source: program.source });
    },
  );

  server.registerTool(
    'readAutomation',
    {
      title: 'Read part of an automation',
      description:
        "Read an automation's program text a window at a time, by id or exact name — cheaper than getAutomation when you only need to see (or re-check) part of a long file. Pass offset (1-based line number, default 1) and limit (line count, default the rest of the file). Returns { id, name, revision, totalLines, offset, lines: [{ n, text }] }. Line numbers are only valid against THIS read — anything else that edits the file moves them, so anchor an edit on the text itself (editAutomation), never on n.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        idOrName,
        offset: z.number().int().min(1).optional().describe('1-based line number to start from. Default 1.'),
        limit: z.number().int().min(1).optional().describe('How many lines to return. Default: the rest of the file.'),
      },
    },
    async (input) => {
      const program = await resolveProgram(tenant, input.idOrName);
      if (program === null) return notFound(input.idOrName);
      return json(readWindow(program, { ...(input.offset !== undefined ? { offset: input.offset } : {}), ...(input.limit !== undefined ? { limit: input.limit } : {}) }));
    },
  );

  server.registerTool(
    'editAutomation',
    {
      title: 'Edit an automation',
      description:
        "Change one saved automation by splicing a snippet into it, without resending the whole program. Pass its id or exact name, oldString, and newString; oldString must appear in the CURRENT source exactly once — read it first (readAutomation or getAutomation) and quote enough surrounding text to pin one spot — or the edit is refused, telling you whether the anchor was not found or matched more than once (pass replaceAll: true to change every match instead of widening the anchor). Once the anchor resolves, this IS saveAutomation with the spliced result as the new source: pass expectedRevision (the revision you just read) so a concurrent edit is caught rather than clobbered, and the same check runs first — an edit with errors is not saved and its diagnostics come back; acknowledgeErrors ships it anyway, exactly like save. There is no draft lane: an edit to a saved library is visible to every importer immediately. Returns save's result plus the new revision.",
      annotations: { destructiveHint: true },
      inputSchema: {
        idOrName,
        oldString: z.string().describe('The exact text to find in the current source.'),
        newString: z.string().describe('The text to put in its place.'),
        replaceAll: z.boolean().optional().describe('Replace every match instead of requiring oldString to be unique.'),
        expectedRevision: z
          .string()
          .optional()
          .describe('The `revision` from your last read of this automation. A mismatch (someone saved a newer version since) is rejected as a conflict instead of overwriting; re-read and retry with the new revision.'),
        acknowledgeErrors: z
          .boolean()
          .optional()
          .describe("Consent to ship the edit even if it has errors or cannot be verified — same as saveAutomation's acknowledgeErrors."),
      },
    },
    async (input) => {
      const program = await resolveProgram(tenant, input.idOrName);
      if (program === null) return notFound(input.idOrName);
      const spliced = applyContentEdit({
        source: program.source,
        oldString: input.oldString,
        newString: input.newString,
        ...(input.replaceAll !== undefined ? { replaceAll: input.replaceAll } : {}),
      });
      if (!spliced.ok) return refuse(spliced.error);
      return saveChecked(tenant, {
        source: spliced.source,
        existing: program,
        ...(input.acknowledgeErrors !== undefined ? { acknowledgeErrors: input.acknowledgeErrors } : {}),
        ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
      });
    },
  );

  server.registerTool(
    'grepAutomations',
    {
      title: 'Search your automations',
      description:
        'Search across your automations for a literal snippet (or, with isRegex: true, a regular expression) and get back every matching line: { matches: [{ id, name, line, text, before, after }], truncated }. contextLines adds lines of surrounding context per match (default 0). Capped at 200 matches. Use it to find where something is defined or used before you edit it.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        pattern: z.string().min(1).describe('The text to search for.'),
        isRegex: z.boolean().optional().describe('Treat pattern as a regular expression.'),
        contextLines: z.number().int().min(0).max(20).optional().describe('Lines of context to include before/after each match. Default 0.'),
      },
    },
    async (input) => json(grepPrograms(await tenant.programs.list(), input)),
  );

  const runs = tenant.runs;
  if (runs === undefined) return;

  server.registerTool(
    'runAutomation',
    {
      title: 'Run an automation',
      description:
        'Dispatch a saved automation and return with { runId, status } — the run may execute asynchronously and take a while (extraction + writes), so this does NOT wait for completion. The automation must declare a manual channel (`listen to manual`; saveAutomation says whether it is `runnable`). Pass the automation id (from listAutomations / getAutomation), optionally text and/or files as its input, and a requestId of your own so a retry returns the first run instead of starting a second. Then POLL checkRun with the runId until status leaves "running".',
      annotations: { destructiveHint: true },
      inputSchema: {
        automation: z.string().describe('The automation id to run (from listAutomations / getAutomation).'),
        text: z.string().optional().describe("Free-form text to supply as the run's input."),
        files: z
          .array(z.object({ filename: z.string(), contentType: z.string(), contentBase64: z.string().describe('Base64-encoded file bytes.') }))
          .optional()
          .describe("Files to supply as the run's input."),
        requestId: z.string().min(1).max(200).optional().describe('Your id for this request: a retry carrying the same id gets the first run back.'),
      },
    },
    async (input) => {
      const program = await resolveProgram(tenant, input.automation);
      if (program === null) return notFound(input.automation);
      const started = await runs.start({
        program,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.files !== undefined ? { files: input.files } : {}),
        ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      });
      if (!started.ok) return refuse(started.error);
      return json({
        runId: started.runId,
        status: started.status,
        automation: program.name,
        hint: 'Poll checkRun with this runId until status leaves "running" — it settles to "success" / "partial" / "failed" (or "parked" — waiting on a timer or a person).',
      });
    },
  );

  server.registerTool(
    'checkRun',
    {
      title: "Check a run's status",
      description:
        'Read one automation run\'s status by id — the poll target for runAutomation. Pass the runId returned by runAutomation. Returns { status, recordCount, startedAt, finishedAt, failureReason, costUsd, modelCalls }. status is "running" while it executes, then settles to "success" / "partial" / "failed" (or "parked" — paused, waiting on a timer or a person). Poll every few seconds until status leaves "running". costUsd is the run\'s model-call spend in dollars (0 if it made none); modelCalls is how many calls it made. To see WHAT the run captured and wrote (source event + resolved field values), call inspectRun.',
      annotations: { readOnlyHint: true },
      inputSchema: { runId: z.string().describe('The run id returned by runAutomation.') },
    },
    async ({ runId }) => {
      const view = await runs.status(runId);
      return view === null ? refuse(`run ${runId} not found`) : json(view);
    },
  );

  server.registerTool(
    'listRuns',
    {
      title: "List an automation's runs",
      description:
        "List an automation's recent runs (every listener firing and every runAutomation), newest first — this is how you find the runId for an automation that fired on its own (not just one you launched with runAutomation). Returns each run's { runId, status, recordCount, startedAt, finishedAt, costUsd, modelCalls }. Pass a runId to inspectRun to see what it actually captured and wrote. Pass the automation id or its exact name.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        idOrName,
        limit: z.number().int().min(1).optional().describe('Max runs to return (default 20, newest first).'),
      },
    },
    async (input) => {
      const program = await resolveProgram(tenant, input.idOrName);
      if (program === null) return notFound(input.idOrName);
      return json({ runs: await runs.list(program, { limit: input.limit ?? 20 }) });
    },
  );

  server.registerTool(
    'inspectRun',
    {
      title: 'Inspect a run',
      description:
        'See what a run actually did. Pass a runId (from listRuns or checkRun) and get back the source event that fired it, the writes it made with the FINAL field values each wrote, the decision trace (gate/branch outcomes, extraction emissions), and any errors, plus its status and model-call spend. A FAILED run still lists the writes that landed before it stopped — check them before re-running, or you may write the same records twice. The "did it do what I meant?" surface: use it to verify an automation before trusting a live listener.',
      annotations: { readOnlyHint: true },
      inputSchema: { runId: z.string().describe('The run id (from listRuns, runAutomation, or checkRun).') },
    },
    async ({ runId }) => {
      const trace = await runs.trace(runId);
      return trace === null ? refuse(`run ${runId} not found`) : json(trace);
    },
  );
}

const EXTRACT_CACHE_TIP =
  'When `extract(...)` or `extractOne(...)` takes several content arguments, put content shared across calls (a fixed instructions or reference document) first and the per-call content (the email body) after it: the prompt is cached on the longest shared prefix.';
