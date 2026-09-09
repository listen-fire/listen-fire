/**
 * Editor-action vocabulary for the live-authoring view (V2).
 *
 * Semantic, name-keyed projections of the translation agent's tool calls —
 * derived at the orchestration seam (see `lib/knowledge/editor_actions.ts`),
 * NOT emitted from inside the agent or its tools. The live-authoring box
 * replays these on the shared `TgGraphView` to render "the agent's cursor":
 * focus a node, settle a finished field value in, flash the completions it
 * chose from, flag a credential it bound.
 *
 * Every reference is a NAME (node path / field name / credential name),
 * never a UUID — the view resolves nothing (N3-N).
 *
 * activity layer
 */
export type EditorActionType =
  /** Move the cursor to a node (select + scroll). */
  | 'focusNode'
  /** A field's value was authored — settle the finished expression in. */
  | 'editField'
  /** The options a completions lookup surfaced at a field/node. */
  | 'showCompletions'
  /** A credential (source/target) was bound to a role. */
  | 'bindCredential';

export type EditorAction =
  | { type: 'focusNode'; nodeName: string }
  | { type: 'editField'; nodeName: string; fieldName: string; value: string | null }
  | { type: 'showCompletions'; nodeName: string; fieldName: string | null; options: string[] }
  | { type: 'bindCredential'; role: string; name: string };

/**
 * The demo-mode build stage (plans/2026-06-16-demo-build-stage). When the user
 * is watching (Follow armed), the agent narrates authoring as a sequence of
 * phases, each carrying the real artifact it's working on.
 */
export type BuildPhase = 'plan' | 'read' | 'study' | 'draft' | 'fill' | 'check' | 'fix' | 'live';

export interface BuildBeat {
  phase: BuildPhase;
  /** One human line: "Reading the Writes playbook", "Studying Attio". */
  label: string;
  /** The real thing it's working on — a passage, the fields it found, the pick it made. */
  artifact?: string;
  /** On the final 'live' beat: the saved movement to resolve the stage to. */
  movementId?: string;
}

export type AgentUpdate = {
  sessionId: string;
  type:
    | 'start'
    | 'tool_call'
    | 'tool_result'
    | 'thinking'
    | 'complete'
    | 'error'
    // Demo build stage: `build` carries a BuildBeat in `data`; `draft` carries
    // `{ source: string }` — the program-so-far for the editor to type in;
    // `plan` carries `{ steps: string[] }` — the ~5-step approach shown on the
    // editor overlay + sidebar before it writes.
    | 'build'
    | 'draft'
    | 'plan'
    | EditorActionType;
  message: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data?: any;
  timestamp: number;
};
