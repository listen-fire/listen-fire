// Shared types for the assistant — one chat core rendered in two
// presentations (slide-over panel and the full /ask page).

export type EntityRef = {
  nodeId: string;
  nodeTypeId: string;
  nodeTypeName?: string;
  category?: string;
  summary?: string;
  displayName?: string;
  rawText?: string;
};

export type SourceRef = {
  resourceId: string;
  resourceName: string;
  resourceType: string;
  resourceUrl?: string;
  rawText?: string;
};

export type WebResult = {
  title: string;
  url: string;
  snippet: string;
};

export type TraceMetadata = {
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
};

export type ToolTraceEntry = {
  tool: string;
  args?: Record<string, unknown>;
  ms: number;
  resultSize: number;
  thinking?: string;
  metadata?: TraceMetadata;
};

export type SuggestedAction = {
  label: string;
  message: string;
  detail?: unknown;
  /**
   * When present, clicking this action does NOT send `message` to the agent —
   * it dispatches to the app's connect-action handler registry by `kind`,
   * the SAME registry the movement editor uses. This is the chat surface of
   * the generalised "+" connect affordance: the adapter declares the action
   * (an `action` block in the manifest's `construction` list), the agent
   * surfaces it here, and the app-
   * shipped handler runs it (e.g. the Google Drive Picker). Consumer-neutral
   * declaration, single handler — only the surface differs from the editor.
   *
   */
  connectAction?: {
    kind: string;
    adapter: string;
    credential?: string;
    serviceType?: string;
  };
};

/** Agent-generated output attachment (chart, spreadsheet, …). */
export type AttachmentRef = {
  title: string;
  format: string;
  objectUri: string;
  mimeType: string;
  sizeBytes: number;
};

/** A file the user attached to a turn. */
export type UploadedFileRef = {
  documentId: string;
  filename: string;
};

export type Message = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  trace?: ToolTraceEntry[];
  suggestedActions?: SuggestedAction[];
  attachments?: AttachmentRef[];
  /** Files the user attached to this turn (chips in history). */
  files?: UploadedFileRef[];
  agent?: string | null;
  messageType?: string;
};

/** A file uploaded but not yet sent with a message. */
export type PendingFile = {
  documentId: string;
  filename: string;
};

export type ConversationListItem = {
  id: string;
  title: string | null;
  updatedAt: string | Date;
  preview: string | null;
  legacyDomain: string | null;
};

export type DocumentMode = "collaborating" | "input";

export function formatRelativeTime(dateStr: string | Date) {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return "Just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
