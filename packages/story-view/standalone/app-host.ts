/**
 * The chat host, as seen from inside the iframe.
 *
 * An MCP App is an MCP client whose transport is `postMessage` to whatever
 * embedded it: it announces itself, is told about the tool call that opened
 * it, and is handed that call's result. The whole conversation is JSON-RPC
 * 2.0, so this file is the wire protocol and nothing else — the drawing lives
 * in `app-entry`, and it never learns how the data arrived.
 *
 * Written against the protocol rather than the SDK on purpose. The published
 * SDK carries the entire MCP client (~370kB after minification) to send four
 * messages, and it peers on a newer core SDK than the API runs — a version
 * we are not moving for a picture. The spec documents this direct path and
 * names every message; the names below are quoted from it verbatim, because a
 * misspelling here is invisible: the host simply never speaks to us and the
 * panel stays empty.
 *
 * @see https://modelcontextprotocol.io/extensions/apps/overview (SEP-1865)
 */

const PROTOCOL_VERSION = "2026-01-26";

/** Everything the host tells us about the frame we are drawing into. */
export interface HostContext {
  theme?: "light" | "dark";
  styles?: { variables?: Record<string, string | undefined> };
  containerDimensions?: { height?: number; maxHeight?: number; width?: number; maxWidth?: number };
  /**
   * NOT in the spec. `ui/notifications/tool-result` is defined only for a
   * View that is "displayed during tool execution" — reopening a chat mounts
   * a fresh View for a call that already finished, maybe a day ago, and
   * SEP-1865 says nothing about how — or whether — a host hands that View
   * its result. Read defensively, on the one channel a pushed notification
   * cannot outrace: a REPLY to a request WE choose when to send, which by
   * construction cannot arrive before our own listener does. Absent on every
   * host verified so far; present only if a host chooses to answer the gap
   * this way.
   */
  toolResult?: ToolResult;
}

/** The tool result, exactly as the server returned it (a `CallToolResult`). */
export interface ToolResult {
  content?: { type: string; text?: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

type Message = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
};

export interface AppHost {
  /** Announce the app and wait to be admitted; resolves with the host's context. */
  connect(): Promise<HostContext | undefined>;
  /** The result of the tool call that opened this view. Set before connecting. */
  onToolResult(handler: (result: ToolResult) => void): void;
  /** Ask the host to open a URL — an iframe this sandboxed cannot navigate. */
  openLink(url: string): void;
  /** Tell a host that sizes itself around us how much room we want. */
  reportSize(width: number, height: number): void;
}

export function connectToHost(app: { name: string; version: string }): AppHost {
  const parent = window.parent;
  let nextId = 1;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (e: Error) => void }>();
  const notified = new Map<string, (params: never) => void>();

  window.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as Message | undefined;
    if (!data || data.jsonrpc !== "2.0") return;

    if (typeof data.id === "number" && (data.result !== undefined || data.error !== undefined)) {
      const waiting = pending.get(data.id);
      if (!waiting) return;
      pending.delete(data.id);
      if (data.error) waiting.reject(new Error(data.error.message));
      else waiting.resolve(data.result);
      return;
    }

    if (data.method) {
      const handler = notified.get(data.method);
      if (handler) handler(data.params as never);
    }
  });

  function notify(method: string, params?: unknown): void {
    parent.postMessage({ jsonrpc: "2.0", method, params }, "*");
  }

  function request(method: string, params?: unknown): Promise<unknown> {
    const id = nextId++;
    const answered = new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
    return answered;
  }

  return {
    onToolResult(handler) {
      // Registered before `connect`, always: the host is free to deliver the
      // result the instant we say we are ready, and a notification that
      // arrives before its handler is simply lost.
      notified.set("ui/notifications/tool-result", handler as (params: never) => void);
    },

    async connect() {
      const result = (await request("ui/initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: app,
        appCapabilities: { availableDisplayModes: ["inline", "fullscreen"] },
      })) as { hostContext?: HostContext } | undefined;
      notify("ui/notifications/initialized");
      return result?.hostContext;
    },

    openLink(url) {
      void request("ui/open-link", { url }).catch(() => undefined);
    },

    reportSize(width, height) {
      notify("ui/notifications/size-changed", { width, height });
    },
  };
}
