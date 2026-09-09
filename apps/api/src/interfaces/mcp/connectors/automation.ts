// The automations MCP connector, as it was mounted inline in server.ts.
// Moved here so a deployment that does not run automations does not serve it
// (D30(d)); the definition itself is unchanged.

import { Router } from 'express';
import { z } from 'zod';

import { createMcpRouter } from '../server';
import { storyApp } from '../story_app';
import { AUTOMATION_MCP_PATH } from '../paths';

function createAutomationMcpRouter(): ReturnType<typeof Router> {
  return createMcpRouter({
    name: 'listen-fire-automation',
    domain: 'automation',
    genericApiTools: false,
    instructions:
      "To automate anything for the user — react to events, move data between their systems, push into their CRM or chat — build an \"automation\" here: a small program over their real connected systems. This connector is how you make Listen-Fire DO things.\n\nThe relationship. The user owns the outcome, like a product owner; the how is yours, handled quietly. Speak in their business terms — a contact added to their CRM, a deal posted to their channel — never in authoring vocabulary (nodes, edges, writes, listeners) and never narrating tool calls. Surface only the decisions that change what happens in the world: what triggers it, what gets created where, how duplicates are treated, when it goes live. When you hand over a link — to connect a system, grant access, subscribe — make it a labelled, tappable markdown link, never a bare URL.\n\nThe loop. Read the automations handbook's `foundations` chapter first (one readHandbook call — it carries the model, the conventions, and the map of what to read next; a later read can name a single section, \"writes#identity\", rather than pay for a whole chapter; where anything else disagrees with the handbook, the handbook wins). Call listConnections early and reconcile it against the task — mint any missing connection first via connectSystem. Author against describeConnection's real record and field names, never from memory. Then validateAutomation, saveAutomation, run it on the user's real input, and show them what happened, in their terms. Once something is saved, prefer a small edit over resending the whole program: readAutomation (or getAutomation, which also carries its metadata) to see the current text, grepAutomations to find where something is defined or used, and editAutomation to change it — anchored on a unique snippet plus the revision you just read, so a concurrent edit is caught instead of clobbered. Reach for saveAutomation itself only for a brand-new automation or a genuine rewrite. A write a third party sees (an email, a message to someone else) gets an approval step inside the automation — a question a person acts on — rather than a preview in chat. The user's knowledge graph is reachable as the `kg` system in listConnections.\n\nTeams. This connection spans the user's teams (listTeams). Creating or changing anything in a team needs its id as `team`; with exactly one team you may omit it.",
    tools: {
      listTeams: {
        description:
          "List the teams this connection can act in (teamId, name, access, isPersonal). `isPersonal: true` marks the user's personal workspace (their team-of-one) vs a shared team. Pass a team's id as `team` to tools that create or change things (saveAutomation, runAutomation, connectSystem, …). listAutomations and listReviews already tag their results with the team.",
        annotations: { readOnlyHint: true },
        inputSchema: {},
        title: 'List your teams',
        endpoint: { method: 'GET', path: '/v1/automation/teams' },
      },
      listReviews: {
        description:
          "List the open reviews (interaction requests) from paused automation runs that are waiting on an answer. Each returns a requestId, interactionType (Check / Choose / Pick / Review / Notify / …), result type, and title. Poll this to discover what's waiting on your review, then answer with submitReview.",
        annotations: { readOnlyHint: true },
        inputSchema: {},
        title: 'List items waiting for your review',
        endpoint: { method: 'GET', path: '/v1/automation/reviews', inputLocation: 'query' },
      },
      submitReview: {
        description:
          "Submit the user's response to an item a paused automation run is waiting on; the run then resumes. Pass the requestId (from listReviews) and the answer SHAPED to the review's interactionType — pass the structured value, do NOT stringify it:\n" +
          '• Check → a boolean (true / false).\n' +
          "• Choose → the chosen enum member; Pick / Select → the chosen option id (or an array of ids for a multi-select). Use the option ids from the review's args.\n" +
          "• Provide → the value matching the review's resultType (a number for a number result, a string for text, etc.).\n" +
          '• Review / Notify → an acknowledgement string (e.g. "ack").\n' +
          "• Correct → the edited review table as { rows: [{ ephemeralId, fields }], dropped: [ephemeralId, …] }. Take the records from the review's args.correct.rows, apply the user's corrections to each row's fields, keep each kept row by its ephemeralId, and list any removed records' ephemeralIds in `dropped`.",
        inputSchema: {
          requestId: z.string().describe("The review's requestId (from listReviews)"),
          // The answer is structured per interaction kind — a boolean, a string,
          // a number, a list of option ids, or a Correct edit object { rows,
          // dropped }. Accept any JSON value and forward it as-is (no
          // stringification); recordAnswer validates it against the result type.
          answer: z
            .union([
              z.boolean(),
              z.number(),
              z.string(),
              z.array(z.unknown()),
              z.record(z.string(), z.unknown()),
            ])
            .describe(
              "The answer, shaped to the review's interactionType (see the tool description). A boolean for a Check; an option id / array of ids for Pick/Select; a number/string value for Provide; { rows, dropped } for a Correct. Passed through and validated server-side — do not stringify.",
            ),
        },
        title: 'Submit your review',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/reviews/:requestId/answer' },
      },
      sendFeedback: {
        description:
          "Send this deployment's operator a short feedback note when you or the user hit friction — something confusing, broken, missing, or harder than it should be while automating. Use it proactively whenever the experience gets in the way (a tool that won't do what's needed, a connector that can't connect, a repeated dead-end), and whenever the user voices a complaint or a wish. It's a one-way report to the person who runs this deployment — it does NOT fix the problem or reply to the user, so don't offer it as a solution; just file it and carry on. `goal` = what the user was trying to achieve, `friction` = what went wrong or got in the way (be specific and concrete).",
        inputSchema: {
          goal: z
            .string()
            .describe(
              'What the user was trying to achieve, in plain terms (e.g. "sync new Gmail leads into Attio").',
            ),
          friction: z
            .string()
            .describe(
              'What went wrong or got in the way — the specific difficulty, dead-end, or confusion. Concrete details help the operator act on it.',
            ),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); defaults to the acting team.'),
        },
        title: 'Send feedback to the operator',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/feedback' },
      },
      readHandbook: {
        description:
          'START HERE to learn how to automate. The Listen-Fire handbooks teach every capability directly (setting up automations, the knowledge model, querying, connecting integrations) — read them, then do the work yourself. No args → every handbook + its chapters. handbook → that handbook\'s chapter index, whose "when to read what" routes each situation to a `chapter` or a `chapter#section`. handbook + chapter (or chapters[]) → the bodies — go straight there when you know what you need; you don\'t have to list the shelf first. A chapter id may name ONE SECTION of it — "writes#identity" — and that is what to fetch for a single rule, rather than paying for a whole chapter. Read the relevant chapters BEFORE setting up an automation; the automation model, the one cardinal rule, and the conventions are all in the automations handbook\'s `foundations` chapter.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          handbook: z
            .string()
            .optional()
            .describe(
              'Handbook id from the shelf (call readHandbook with no arguments to list them), e.g. "automations", "knowledge-model", "using-listen-fire".',
            ),
          chapter: z
            .string()
            .optional()
            .describe('A single chapter id, or one section of it: "writes" / "writes#identity".'),
          chapters: z
            .array(z.string())
            .optional()
            .describe(
              'Several chapters or sections to read in one call, e.g. ["foundations","writes#identity","system:slack"] (preferred — frontload the reading).',
            ),
        },
        title: 'Read the Listen-Fire handbook',
        endpoint: { method: 'POST', path: '/v1/automation/handbook' },
      },
      listConnections: {
        description:
          'The connected systems list: the workspace\'s real systems (with construction args + listener-config keys), connections, plugins, and knowledge-graph type names. These are the ONLY names valid in automation imports and constructions — never invent one. Each system carries how it connects — `connect`: "oauth" (browser sign-in), "key-entry" (paste an API key), "intrinsic" (part of Listen-Fire — one-click setup, no sign-in, e.g. Listen-Fire Valuations), "handshake" (the link hands the user into the system\'s own linking flow, e.g. Telegram\'s bot Start step), or "app-only" (connected inside the Listen-Fire app — connectSystem can\'t link it); absent means it needs no connection. Where a system carries `triggerExpectation`, that is the plain-language truth about WHICH events a listener on it actually fires on (e.g. which Telegram messages reach the bot) — ground every trigger-surface claim you make to the user in it rather than guessing. Call describeConnection for a system\'s live field schema before authoring against it.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'List connected systems',
        endpoint: { method: 'GET', path: '/v1/automation/connections' },
      },
      describeConnection: {
        description:
          "The live shape of one connected system, ONE PLACE AT A TIME. You get the node you asked about: what it is, its properties (exact field names, types, which are writable, which are required), and every edge leaving it. Every call re-reads the system's live schema, so it's safe to call again right after adding a field in the external workspace. ALWAYS call this before authoring an automation that reads or writes a system — the field names you use must match exactly. Omit `position` and you land at the system's ROOT: what the system is, and the ways in. Each edge tells you its promises (`readable`, `writable`, and `fires` — a `fires` edge is one an event is PUSHED along, which is what a listener subscribes to), what you would LAND ON if you followed it, and a `position` string that walks it (see the `position` argument). An edge's `target` is usually described in full, so you can author a write against it with no further call. When a target is marked `stub: true` the system judged fetching its fields too expensive to do up front (a CRM with hundreds of objects, say) — it is still named, and one hop resolves it. A stub is never a node without fields; it is fields not yet fetched. Where an edge is polymorphic it carries `members` — the actual things you can pick between (your Airtable bases, your granted spreadsheets) — and `narrowBy`, the fields a `WHERE` may test. Each member carries its own `position`, and that string is exactly what goes in the automation's traversal, so exploring and authoring share one vocabulary. Also useful BEFORE anything is connected: it returns the system's `description` and `triggerExpectation` (what a listener actually fires on), an `identity` note (who a movement over it runs as, and whose activity triggers a listener — e.g. that other people in a shared workspace need their own Listen-Fire account for it to fire on their activity), and a `capability` note (what it can and can't read or write), even when no connection exists yet, so you can answer scope questions at planning time. Ground identity and capability claims to the user in these.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          system: z
            .union([z.string(), z.array(z.string())])
            .describe(
              'The system name (from listConnections), e.g. "attio". Pass an array (e.g. ["slack","attio"]) to describe several systems in one call — preferred when your automation touches more than one.',
            ),
          connection: z
            .string()
            .optional()
            .describe('Which connection to describe against (defaults to the system name).'),
          types: z
            .array(z.string())
            .optional()
            .describe(
              'Ask for these type names by name instead of walking to them. Rarely needed — prefer `position`, which is how the system tells you what exists. An entry may also be a PATH, the traversal that reaches a type written exactly as in an automation: \\"-[:`Sales CRM`]->-[:Companies]->\\".',
            ),
          position: z
            .string()
            .optional()
            .describe(
              "WHERE TO STAND in the system. Omit it and you get the system's root: what it is, and every edge leaving it. The response's `node` describes that one place — its properties, and each edge with what you would LAND ON if you followed it (so you can author a write straight away, with no further call) plus a `position` string. To look deeper, pass one of those strings back here verbatim: that is one hop, and the only thing a hop buys you is the landing's OWN edges. Never compose one of these yourself — an address is only ever something a previous call handed you.",
            ),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Describe a connected system',
        endpoint: { method: 'POST', path: '/v1/automation/connections/describe' },
      },
      connectSystem: {
        description:
          'AUTHOR-TIME ONLY: if a system the automation needs is NOT yet connected (absent from the connected systems list, or it has a "no connection" note), mint a single-use connection link and give it to the user to open in their browser. Works for the "oauth", "key-entry", "intrinsic", and "handshake" connect kinds listConnections reports. Do NOT call it for an "app-only" system: it has no link path and connects inside the Listen-Fire app — tell the user to connect it there. Returns a link to send the user, the connect kind, the name the connection will be stored under, and when the link expires. Relay the url to the user ("open this to connect <system>"); once they confirm, call listConnections again — the connection shows up in the results once it lands (for "handshake" it appears when they click Connect; remind them to also press Start in Telegram or inbound messages won\'t route).',
        inputSchema: {
          system: z
            .string()
            .describe(
              'The system name to connect (from listConnections), e.g. "attio", "google_sheets", "slack", "airtable", "dropbox".',
            ),
          connection: z
            .string()
            .optional()
            .describe('Optional name to store the connection under (defaults to the system name).'),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Get a link to connect a system',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/connections/connect' },
      },
      grantAccess: {
        description:
          "AUTHOR-TIME: some systems need access granted to specific items INSIDE an already-connected account — connecting the system isn't enough. Google Sheets is the current case: under Google's drive.file scope, picking is the ONLY way Listen-Fire can reach a pre-existing spreadsheet, and only the picked file becomes visible. Mint a single-use link that opens the provider's picker; relay the url to the user. After they pick, call describeConnection for that system — the granted items' types appear as writable types. Connect the system first (connectSystem) if it isn't connected at all. For a NEW spreadsheet skip the link entirely: automations can create one (write the Spreadsheet type) and access is automatic. Systems that don't need per-item grants return a clear error.",
        inputSchema: {
          system: z
            .string()
            .describe('The system name (from listConnections), e.g. "google_sheets".'),
          connection: z
            .string()
            .optional()
            .describe(
              'Which connection the items should be granted to. Omit when the team has exactly one.',
            ),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Get a link to grant access to items',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/connections/grant-access' },
      },
      linkWhatsappNumber: {
        description:
          "Link the user's WhatsApp number so messages they send to the Listen-Fire WhatsApp number run their automations. Sends a one-time verification code to the number over WhatsApp. Pass the number in full international format (e.g. +447700900000). Returns instructions: ask the user for the code they received on WhatsApp, then call confirmWhatsappCode with the same number and that code. A number must be linked this way before a WhatsApp listener will fire for that person — an unverified number is ignored. If the number is already linked to a different account, or a code was just sent, the call returns a clear reason.",
        inputSchema: {
          phoneNumber: z
            .string()
            .describe(
              "The user's WhatsApp number in full international format, e.g. +447700900000.",
            ),
        },
        title: 'Link a WhatsApp number',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/whatsapp/verify/start' },
      },
      confirmWhatsappCode: {
        description:
          "Finish linking a WhatsApp number by confirming the code the user received. Pass the same number given to linkWhatsappNumber and the code. On success the number is verified and the user's messages to the Listen-Fire WhatsApp number will run their automations, and the result includes a wa.me chat link — give it to the user so they can open WhatsApp and start messaging Listen-Fire in one tap. A wrong, expired, or already-used code returns a clear reason so you can ask the user to try again or request a fresh code.",
        inputSchema: {
          phoneNumber: z
            .string()
            .describe('The same number passed to linkWhatsappNumber, full international format.'),
          code: z.string().describe('The verification code the user received on WhatsApp.'),
        },
        title: 'Confirm a WhatsApp code',
        annotations: { destructiveHint: false },
        endpoint: { method: 'POST', path: '/v1/automation/whatsapp/verify/confirm' },
      },
      validateAutomation: {
        description:
          'Typecheck an automation program against the live connected systems WITHOUT saving: parse, check, and compile. Returns diagnostics (code, message, severity, line/col, offending line). A clean validation predicts a live save — ALWAYS run this before saveAutomation.',
        inputSchema: {
          source: z.string().describe('The automation program text (.mvt).'),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Validate an automation',
        annotations: { readOnlyHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/validate' },
      },
      saveAutomation: {
        description:
          'Save an automation program and provision its listeners (authoring → live). If it is valid, it goes live. If it cannot be verified or has errors, your text is still saved but nothing new goes live — the result comes back as needsConfirmation so you can fix it, or check with the user, first. Pass acknowledgeErrors: true to ship it anyway: it then replaces whatever was running (even broken) and will run and fail visibly. There is no "draft" that quietly keeps the last good version running — what goes live is what you save and confirm. When updating an EXISTING automation, pass expectedRevision so a concurrent edit is caught rather than silently overwritten. Returns needsConfirmation/diagnostics, the provisioned listeners (each channel and the inbound address for email), whether an on-demand run is possible (runnable), storyUrl, and `warnings` — things that saved fine but would surprise the user (a movement name another automation already fires; listeners retired because the saved source could not be read). Always relay a warning to the user in your own words. storyUrl is a link to a picture of what the automation does — its triggers, steps, and the records it touches — for a person to look at, not something you can open yourself; hand it out as a labelled link once the save goes live. Anyone holding it can view with no login, until the automation is deleted. Pass id to re-save/rename. Run validateAutomation first. For a small, targeted change to an existing automation — one line, one field — editAutomation is cheaper: it anchors the change on a snippet instead of resending the whole program.',
        inputSchema: {
          source: z.string().describe('The automation program text (.mvt).'),
          name: z
            .string()
            .optional()
            .describe('Human-readable display name (plain words, no underscores).'),
          description: z.string().optional().describe('Optional one-line description.'),
          id: z
            .string()
            .optional()
            .describe('Existing automation id when re-saving/renaming (from listAutomations).'),
          acknowledgeErrors: z
            .boolean()
            .optional()
            .describe(
              'Consent to ship an automation that has errors or cannot be verified. Without it, such a save comes back as needsConfirmation and nothing new goes live. With it, the automation ships and replaces whatever was running (even broken), so it runs and fails visibly — only pass it once the user has agreed to that. If the source cannot even be READ (a syntax error), shipping it also retires every listener the automation had: it stops firing entirely until a readable source restores them, and the result says so in `warnings`.',
            ),
          expectedRevision: z
            .string()
            .optional()
            .describe(
              "The `revision` returned by your last getAutomation call for this automation. When updating an existing automation, pass it so a concurrent edit can't be silently overwritten — a mismatch (someone saved a newer version since) is rejected; call getAutomation again, merge, and re-save with the new revision. Omit to save regardless of what changed.",
            ),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Save an automation',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/save' },
      },
      deleteAutomation: {
        description:
          'Permanently delete a saved automation and every listener it derives — a HARD delete: the automation and its run triggers are removed, and any external subscriptions it alone kept alive are torn down. There is no undo. Pass the automation id (from listAutomations). Returns { deleted } — false if no automation with that id lives in the resolved team.',
        inputSchema: {
          automation: z.string().describe('The automation id to delete (from listAutomations).'),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Delete an automation',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/delete' },
      },
      listAutomations: {
        description:
          "List the saved automations across every team this connection covers: each one's id, name, status, listeners, storyUrl, and the team it lives in (teamId, teamName). Use the id with getAutomation, saveAutomation, or runAutomation. storyUrl is a link to a picture of what an automation does, for a person to look at — you can't open it yourself, so hand it out as a labelled link when they want to see one. Anyone holding a link can view it with no login, until that automation is deleted.",
        annotations: { readOnlyHint: true },
        inputSchema: {},
        title: 'List automations',
        endpoint: { method: 'GET', path: '/v1/automation/automations' },
      },
      getAutomation: {
        description:
          "Get one saved automation by its id or exact name (looked up across the teams this connection covers): the full program text, status, listeners, `revision` — a fingerprint of its current source — and storyUrl. When you only need the text (or part of it), readAutomation is cheaper; reach for this one when you also want the metadata alongside it. Re-read this or readAutomation (don't reuse an old copy) right before you edit and re-save an existing automation, and pass its `revision` back as saveAutomation's or editAutomation's expectedRevision — that way a concurrent edit by someone else is caught as a conflict instead of silently overwritten. storyUrl is a link to a picture of what it does (its triggers, steps, and the records it touches), for a person to look at — you can't open it yourself, so hand it out as a labelled link when they want to see it. Anyone holding the link can view with no login, until the automation is deleted. In a chat that can show it, that same picture is drawn right below this answer, so there is no need to describe it.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          idOrName: z
            .string()
            .describe('The automation id (from listAutomations) or its exact name.'),
        },
        title: 'Get an automation',
        endpoint: { method: 'GET', path: '/v1/automation/automations/:idOrName' },
        app: storyApp,
      },
      readAutomation: {
        description:
          "Read an automation's program text a window at a time, by id or exact name — cheaper than getAutomation when you only need to see (or re-check) part of a long file. Pass offset (1-based line number, default 1) and limit (line count, default the rest of the file). Returns { id, name, revision, totalLines, offset, lines: [{ n, text }] }. Line numbers are only valid against THIS read — anything else that edits the file moves them, so anchor an edit on the text itself (editAutomation), never on n.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          idOrName: z
            .string()
            .describe('The automation id (from listAutomations) or its exact name.'),
          offset: z.number().int().min(1).optional().describe('1-based line number to start from. Default 1.'),
          limit: z
            .number()
            .int()
            .min(1)
            .optional()
            .describe('How many lines to return. Default: the rest of the file.'),
        },
        title: 'Read part of an automation',
        endpoint: { method: 'GET', path: '/v1/automation/automations/:idOrName/source' },
      },
      editAutomation: {
        description:
          "Change one saved automation by splicing a snippet into it, without resending the whole program. Pass its id or exact name, oldString, and newString; oldString must appear in the CURRENT source exactly once — read it first (readAutomation or getAutomation) and quote enough surrounding text to pin one spot — or the edit is refused, telling you whether the anchor was not found or matched more than once (pass replaceAll: true to change every match instead of widening the anchor). Once the anchor resolves, this IS saveAutomation with the spliced result as the new source: pass expectedRevision (the revision you just read) so a concurrent edit is caught rather than clobbered, and the same validity gate applies — an edit that breaks the automation still saves the text but needs acknowledgeErrors to ship, exactly like save. There is no draft lane: an edit to a saved library is visible to every importer immediately. Returns save's result plus the new revision.",
        inputSchema: {
          idOrName: z
            .string()
            .describe('The automation id (from listAutomations) or its exact name.'),
          oldString: z.string().describe('The exact text to find in the current source.'),
          newString: z.string().describe('The text to put in its place.'),
          replaceAll: z
            .boolean()
            .optional()
            .describe('Replace every match instead of requiring oldString to be unique.'),
          expectedRevision: z
            .string()
            .optional()
            .describe(
              "The `revision` from your last read of this automation. A mismatch (someone saved a newer version since) is rejected as a conflict instead of overwriting; re-read and retry with the new revision.",
            ),
          acknowledgeErrors: z
            .boolean()
            .optional()
            .describe(
              'Consent to ship the edit even if it has errors or cannot be verified — same as saveAutomation\'s acknowledgeErrors.',
            ),
        },
        title: 'Edit an automation',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/:idOrName/edit' },
      },
      grepAutomations: {
        description:
          'Search across your automations for a literal snippet (or, with isRegex: true, a regular expression) and get back every matching line: { matches: [{ id, name, teamId, line, text, before, after }], truncated }. contextLines adds lines of surrounding context per match (default 0). Spans every team this connection covers unless you pass team. Capped at 200 matches. Use it to find where something is defined or used before you edit it.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          pattern: z.string().describe('The text to search for.'),
          isRegex: z.boolean().optional().describe('Treat pattern as a regular expression.'),
          contextLines: z
            .number()
            .int()
            .min(0)
            .max(20)
            .optional()
            .describe('Lines of context to include before/after each match. Default 0.'),
          team: z.string().optional().describe('Team id (see instructions). Default: every team this connection covers.'),
        },
        title: 'Search your automations',
        endpoint: { method: 'GET', path: '/v1/automation/automations/grep' },
      },
      runAutomation: {
        description:
          'Dispatch a saved automation and return IMMEDIATELY with { runId, status: "running" } — the run executes asynchronously and may take a while (extraction + writes), so it does NOT wait for completion. The automation must declare a manual channel (it goes live with one). Pass the automation id (from listAutomations / getAutomation), optionally text and/or files as its input. Then POLL checkRun with the runId until status leaves "running".',
        inputSchema: {
          automation: z
            .string()
            .describe('The automation id to run (from listAutomations / getAutomation).'),
          text: z.string().optional().describe("Free-form text to supply as the run's input."),
          files: z
            .array(
              z.object({
                filename: z.string(),
                contentType: z.string(),
                contentBase64: z.string().describe('Base64-encoded file bytes.'),
              }),
            )
            .optional()
            .describe("Files to supply as the run's input."),
          team: z.string().optional().describe('Team id (see instructions).'),
        },
        title: 'Run an automation',
        annotations: { destructiveHint: true },
        endpoint: { method: 'POST', path: '/v1/automation/automations/run' },
      },
      checkRun: {
        description:
          'Read one automation run\'s status by id — the poll target for runAutomation\'s async dispatch. Pass the runId returned by runAutomation. Returns { status, recordCount, errors, startedAt, finishedAt, failedAt, failureReason }. status is "running" while it executes, then settles to "success" / "partial" / "failed" (or "parked" — paused, waiting for your review — see listReviews). Poll every few seconds until status leaves "running". To see WHAT the run captured and wrote (source event + resolved field values), call inspectRun.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          runId: z.string().describe('The run id returned by runAutomation.'),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); omit to search across your teams.'),
        },
        title: "Check a run's status",
        endpoint: { method: 'POST', path: '/v1/automation/automations/run-status' },
      },
      listRuns: {
        description:
          'List an automation\'s recent runs (every listener firing and "Run now"), newest first — this is how you find the runId for an automation that fired on its own (not just one you launched with runAutomation). Returns each run\'s { runId, lane (which listener), triggerType, status, committed, captured, recordCount, timestamps } — `committed` is how many writes actually landed in a target system, `captured` how many were rehearsed (a `dry_run` target, or a whole-run rehearsal). Pass a runId to inspectRun to see what it actually captured and wrote. Pass the automation id or its exact name.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          idOrName: z
            .string()
            .describe('The automation id (from listAutomations) or its exact name.'),
          limit: z.number().optional().describe('Max runs to return (default 20, newest first).'),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); omit to search across your teams.'),
        },
        title: "List an automation's runs",
        endpoint: { method: 'GET', path: '/v1/automation/automations/:idOrName/runs' },
      },
      inspectRun: {
        description:
          'See what a run actually did. Pass a runId (from listRuns or checkRun) and get back the source event that fired it, the resolved write-plan — every target record and the FINAL field values it wrote, with every set-if-empty (`?:`) rule and enum coercion already applied, each write flagged `committed` (it landed) or not (it was rehearsed — a `dry_run` target, or a whole-run rehearsal) — the decision trace (gate/branch outcomes, extraction emissions), and any errors, plus the run\'s `committed`/`captured` counts. A FAILED run still lists the writes that landed before it stopped — check them before re-running, or you may write the same records twice. The "did it do what I meant?" surface: use it to verify an automation before trusting a live listener, and to read back exactly which writes a rehearsal captured versus committed.',
        annotations: { readOnlyHint: true },
        inputSchema: {
          runId: z.string().describe('The run id (from listRuns, runAutomation, or checkRun).'),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); omit to search across your teams.'),
        },
        title: 'Inspect a run',
        endpoint: { method: 'POST', path: '/v1/automation/automations/inspect-run' },
      },
      cancelRun: {
        description:
          "Stop a run by id — one that's executing or one that's paused waiting on something. Everything the run already did stays done; it just won't do anything more. An executing run stops at its next safe point (usually within seconds). Pass the runId from listRuns / runAutomation / checkRun.",
        annotations: { destructiveHint: true },
        inputSchema: {
          runId: z
            .string()
            .describe('The run id to stop (from listRuns, runAutomation, or checkRun).'),
          team: z
            .string()
            .optional()
            .describe('Team id (see instructions); omit to search across your teams.'),
        },
        title: 'Cancel a run',
        endpoint: { method: 'POST', path: '/v1/automation/automations/cancel-run' },
      },
    },
  });
}

export { AUTOMATION_MCP_PATH, createAutomationMcpRouter };
