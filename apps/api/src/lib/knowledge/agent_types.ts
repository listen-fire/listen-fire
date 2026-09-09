// ---------------------------------------------------------------------------
// Shared agent message-thoughts types.
//
// The reasoning trace persisted per assistant message:
//
//   1. `thinking` — Anthropic extended-thinking content (only populated
//      when the runner is on the Anthropic provider with `thinking:
//      { type: 'enabled' }`). Concatenated across turns of the loop.
//   2. `toolCalls` — the sequence of `(name, args, result | error)`
//      tuples for every tool invocation in this assistant turn.
//
// Persisted into `agent_message.metadata.thoughts`. Additive — old rows
// simply omit the key; readers ignore unknown shapes. Read back by the
// orchestrator (recent-window enrichment) and the running-state
// compaction service.
//
// ---------------------------------------------------------------------------

export interface MessageThoughtsToolCall {
  name: string;
  args: unknown;
  result?: unknown;
  error?: string;
}

export interface MessageThoughts {
  thinking?: string;
  toolCalls?: MessageThoughtsToolCall[];
}

// ── Agent I/O types (extracted from the retired query_agent.ts) ──

export interface IngestableType {
  nodeTypeId: string;
  name: string;
  description: string | null;
}

export type AgentChannel = 'web' | 'whatsapp' | 'slack';

export interface SourceRef {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  resourceUrl?: string;
  rawText?: string;
}

export interface EntityRef {
  nodeId: string;
  nodeTypeId: string;
  nodeTypeName?: string;
  category?: string;
  summary?: string;
  displayName?: string;
  rawText?: string;
}

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SuggestedAction {
  label: string;
  message: string;
  detail?: unknown;
  /** When present, the web dispatches this to the connect-action handler
   *  registry by `kind` instead of sending `message`. `serviceType` is the
   *  ExternalServiceType string the connect handler needs to pick the OAuth
   *  flow. Mirrors apps/web/src/components/assistant/types.ts. */
  connectAction?: {
    kind: string;
    adapter: string;
    credential?: string;
    serviceType?: string;
  };
}

export interface TraceMetadata {
  nodeId?: string;
  nodeTypeId?: string;
  nodeTypeName?: string;
  category?: string;
  summary?: string;
  displayName?: string;
  rawText?: string;
  sources?: SourceRef[];
  entities?: EntityRef[];
  webResults?: WebResult[];
}

export interface ToolTrace {
  tool: string;
  args?: unknown;
  ms: number;
  resultSize: number;
  thinking?: string;
  metadata?: TraceMetadata;
}

export interface ClassifiedType {
  nodeTypeId: string;
  nodeTypeName: string;
}
