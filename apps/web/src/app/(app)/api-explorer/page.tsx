"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiOrigin } from "@/lib/api-origin";
import { useCapabilities } from "@/lib/capabilities-provider";
import { trpc } from "@/lib/trpc";
import { Badge, Button, PageHeader } from "@/components/ui";

type QueryResult = {
  columns: string[];
  data: Record<string, unknown>[];
  meta: { rowCount: number; timeMs: number };
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  query?: string | null;
  result?: QueryResult | null;
  resultError?: string | null;
};

type ApiKey = {
  id: string;
  name: string;
  key: string;
  keyPrefix: string;
  scopes: string[];
  createdAt: string;
};

function CypherBlock({ code }: { code: string }) {
  return (
    <pre className="overflow-x-auto bg-white px-3 py-2.5 text-[13px] leading-relaxed">
      <code>
        {code.split("\n").map((line, i) => {
          const commentIdx = line.indexOf("//");
          if (commentIdx === -1) {
            return (
              <span key={i}>
                <span className="text-gray-800">{line}</span>
                {i < code.split("\n").length - 1 && "\n"}
              </span>
            );
          }
          return (
            <span key={i}>
              <span className="text-gray-800">
                {line.slice(0, commentIdx)}
              </span>
              <span className="text-gray-400">
                {line.slice(commentIdx)}
              </span>
              {i < code.split("\n").length - 1 && "\n"}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function ResultsTable({ result }: { result: QueryResult }) {
  if (result.data.length === 0) {
    return (
      <div className="px-3 py-3 text-[12px] text-gray-400">
        No results returned.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="border-b border-gray-100">
            {result.columns.map((col) => (
              <th
                key={col}
                className="px-3 py-1.5 text-left font-medium text-gray-500"
              >
                {col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.data.map((row, i) => (
            <tr
              key={i}
              className="border-b border-gray-50 last:border-0"
            >
              {result.columns.map((col) => (
                <td
                  key={col}
                  className="px-3 py-1.5 text-gray-700"
                >
                  {row[col] === null ? (
                    <span className="text-gray-300">null</span>
                  ) : typeof row[col] === "object" ? (
                    JSON.stringify(row[col])
                  ) : (
                    String(row[col])
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="border-t border-gray-100 px-3 py-1.5 text-[11px] text-gray-400">
        {result.meta.rowCount} row{result.meta.rowCount !== 1 ? "s" : ""} in{" "}
        {result.meta.timeMs}ms
      </div>
    </div>
  );
}

export default function ApiExplorerPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [schemaOpen, setSchemaOpen] = useState(false);
  const [apiKey, setApiKey] = useState<ApiKey | null>(null);
  const [creatingKey, setCreatingKey] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { data: schema } =
    trpc.views.knowledge.cypherAgent.getSchemaForDisplay.useQuery();
  const { mutateAsync: generate } =
    trpc.views.knowledge.cypherAgent.generate.useMutation();
  const { mutateAsync: executeCypher } =
    trpc.views.knowledge.cypherAgent.execute.useMutation();
  // API keys are core's, and a single-tenant install has no account to mint one
  // against — its own key is the credential. The cypher surface above is this
  // page's real subject and stays either way.
  const capabilities = useCapabilities();
  const canMintApiKeys = capabilities?.identity !== "static";
  const { mutateAsync: createApiKey } =
    trpc.views.apiKeys.create.useMutation();

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isLoading) return;

    setInput("");
    setIsLoading(true);

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: text,
    };
    setMessages((prev) => [...prev, userMsg]);

    try {
      const history = messages.map((m) => ({
        role: m.role,
        content: m.query ? `Query: ${m.query}\n${m.content}` : m.content,
      }));

      const result = await generate({
        description: text,
        conversationHistory: history.slice(-10),
      });

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: result.explanation ?? "",
          query: result.query,
        },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: "assistant",
          content: "Something went wrong. Please try again.",
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }, [input, isLoading, generate, messages]);

  const handleRun = useCallback(
    async (query: string, msgId: string) => {
      setRunningId(msgId);
      try {
        const result = await executeCypher({ query });
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? { ...m, result: result as QueryResult, resultError: null }
              : m,
          ),
        );
      } catch (e) {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  ...m,
                  result: null,
                  resultError:
                    e instanceof Error ? e.message : "Query failed",
                }
              : m,
          ),
        );
      } finally {
        setRunningId(null);
      }
    },
    [executeCypher],
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const apiBaseUrl = apiOrigin();

  // Strip comments for copy/cURL (user wants clean query)
  const stripComments = (q: string) =>
    q
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").trimEnd())
      .filter((l) => l.length > 0)
      .join("\n");

  const copyCurl = (query: string, id: string) => {
    const bearerToken = apiKey?.key ?? "lf_YOUR_API_KEY";
    const clean = stripComments(query);
    const curl = `curl -X POST ${apiBaseUrl}/api/v1/knowledge/cypher \\
  -H "Authorization: Bearer ${bearerToken}" \\
  -H "Content-Type: application/json" \\
  -d ${JSON.stringify(JSON.stringify({ query: clean }))}`;
    copyToClipboard(curl, `curl-${id}`);
  };

  const handleCreateApiKey = async () => {
    setCreatingKey(true);
    try {
      const result = await createApiKey({
        name: "Knowledge API",
        scopes: ["knowledge"],
      });
      setApiKey(result as ApiKey);
    } catch {
      // ignore
    } finally {
      setCreatingKey(false);
    }
  };

  const hasSchema = schema && schema.nodeTypes.length > 0;

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="API Explorer"
        badge={<Badge tone="gray">Cypher</Badge>}
        actions={
          <>
            <Button
              variant={schemaOpen ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSchemaOpen(!schemaOpen)}
            >
              Schema
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setMessages([]);
                setInput("");
              }}
            >
              Clear
            </Button>
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        {/* Main chat area */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex-1 overflow-y-auto px-3 py-4 sm:px-6">
           <div className="mx-auto max-w-2xl">
            {messages.length === 0 && !isLoading && (
              <div className="mx-auto flex max-w-lg flex-col items-center gap-4 pt-16 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gray-100">
                  <svg
                    className="h-6 w-6 text-gray-400"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M8 9h8M8 13h6M21 12c0 4.97-4.03 9-9 9a9 9 0 01-9-9c0-4.97 4.03-9 9-9s9 4.03 9 9z" />
                  </svg>
                </div>
                <div>
                  <p className="text-[14px] font-medium text-gray-900">
                    Describe what you want to query
                  </p>
                  <p className="mt-1 text-[13px] text-gray-500">
                    I&apos;ll generate a Cypher query you can use with the
                    Knowledge API.
                  </p>
                </div>
                {hasSchema && (
                  <div className="mt-2 flex flex-wrap justify-center gap-2">
                    {schema.nodeTypes.slice(0, 4).map((nt) => (
                      <button
                        key={nt.name}
                        onClick={() => {
                          setInput(`Show me all ${nt.name} entities`);
                          inputRef.current?.focus();
                        }}
                        className="rounded-full border border-gray-200 px-3 py-1 text-[12px] text-gray-600 transition-colors hover:border-gray-300 hover:bg-gray-50"
                      >
                        All {nt.name}s
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {messages.map((msg) => (
              <div key={msg.id} className="mb-4">
                {msg.role === "user" ? (
                  <div className="flex justify-end">
                    <div className="max-w-[80%] rounded-lg bg-gray-900 px-3.5 py-2 text-[13px] text-white">
                      {msg.content}
                    </div>
                  </div>
                ) : (
                  <div className="max-w-[90%]">
                    {msg.query && (
                      <div className="mb-2 overflow-hidden rounded-lg border border-gray-200">
                        <div className="flex items-center justify-between bg-gray-50 px-3 py-1.5">
                          <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                            Cypher
                          </span>
                          <div className="flex gap-1">
                            <button
                              onClick={() => handleRun(msg.query!, msg.id)}
                              disabled={runningId === msg.id}
                              className="rounded px-1.5 py-0.5 text-[11px] font-medium text-green-600 transition-colors hover:bg-green-50 disabled:opacity-50"
                            >
                              {runningId === msg.id ? "Running..." : "Run"}
                            </button>
                            <button
                              onClick={() =>
                                copyToClipboard(
                                  stripComments(msg.query!),
                                  msg.id,
                                )
                              }
                              className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
                            >
                              {copiedId === msg.id ? "Copied" : "Copy"}
                            </button>
                            <button
                              onClick={() => copyCurl(msg.query!, msg.id)}
                              className="rounded px-1.5 py-0.5 text-[11px] text-gray-400 transition-colors hover:bg-gray-200 hover:text-gray-600"
                            >
                              {copiedId === `curl-${msg.id}`
                                ? "Copied"
                                : "cURL"}
                            </button>
                          </div>
                        </div>
                        <CypherBlock code={msg.query} />
                      </div>
                    )}
                    {msg.content && (
                      <p className="text-[13px] leading-relaxed text-gray-600">
                        {msg.content}
                      </p>
                    )}
                    {msg.result && (
                      <div className="mt-2 overflow-hidden rounded-lg border border-green-200 bg-green-50/30">
                        <ResultsTable result={msg.result} />
                      </div>
                    )}
                    {msg.resultError && (
                      <div className="mt-2 rounded-lg border border-red-200 bg-red-50/30 px-3 py-2 text-[12px] text-red-600">
                        {msg.resultError}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}

            {isLoading && (
              <div className="mb-4">
                <div className="flex items-center gap-2 py-2">
                  <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400" />
                  <div
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400"
                    style={{ animationDelay: "0.2s" }}
                  />
                  <div
                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-gray-400"
                    style={{ animationDelay: "0.4s" }}
                  />
                  <span className="text-[12px] text-gray-400">
                    Generating query...
                  </span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
           </div>
          </div>

          {/* Input */}
          <div className="shrink-0 border-t border-gray-200 px-3 py-3 sm:px-6">
           <div className="mx-auto max-w-2xl">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`;
                }}
                onKeyDown={handleKeyDown}
                placeholder={
                  hasSchema
                    ? "Describe what data you want..."
                    : "Set up your ontology first to start querying"
                }
                disabled={!hasSchema}
                rows={1}
                className="max-h-[120px] flex-1 resize-none overflow-hidden rounded-lg border border-gray-200 px-3 py-2 text-[13px] placeholder:text-gray-400 focus:border-gray-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-50"
              />
              <button
                onClick={handleSend}
                disabled={!input.trim() || isLoading || !hasSchema}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-white transition-colors hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <svg
                  className="h-4 w-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="22" y1="2" x2="11" y2="13" />
                  <polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
              </button>
            </div>
            <div className="mt-1.5 flex items-center justify-between text-[11px] text-gray-400">
              <span>
                POST /api/v1/knowledge/cypher — Bearer auth with{" "}
                <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[10px]">
                  knowledge
                </code>{" "}
                scope
              </span>
              {!canMintApiKeys ? null : apiKey ? (
                <span className="flex items-center gap-1.5">
                  <code className="rounded bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 ring-1 ring-amber-200 select-all">
                    {apiKey.key}
                  </code>
                  <button
                    onClick={() => copyToClipboard(apiKey.key, "api-key")}
                    className="text-gray-400 hover:text-gray-600"
                  >
                    {copiedId === "api-key" ? (
                      <svg className="h-3 w-3 text-green-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M20 6L9 17l-5-5" />
                      </svg>
                    ) : (
                      <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                      </svg>
                    )}
                  </button>
                  <span className="text-[10px] text-amber-600">
                    Copy now — won&apos;t be shown again
                  </span>
                </span>
              ) : (
                <button
                  onClick={handleCreateApiKey}
                  disabled={creatingKey}
                  className="text-gray-500 underline decoration-gray-300 underline-offset-2 transition-colors hover:text-gray-700 disabled:opacity-50"
                >
                  {creatingKey ? "Creating..." : "Generate API key for cURL"}
                </button>
              )}
            </div>
           </div>
          </div>
        </div>

        {/* Schema sidebar */}
        {schemaOpen && schema && (
          <div className="w-72 shrink-0 overflow-y-auto border-l border-gray-200 bg-gray-50/50 px-4 py-4">
            <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-gray-400">
              Your Schema
            </h3>

            {schema.nodeTypes.length === 0 ? (
              <p className="text-[12px] text-gray-400">
                No node types defined yet.
              </p>
            ) : (
              <>
                <div className="mb-4">
                  <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                    Node Types
                  </h4>
                  {schema.nodeTypes.map((nt) => (
                    <div key={nt.name} className="mb-2">
                      <div className="text-[13px] font-medium text-gray-800">
                        {nt.name}
                      </div>
                      {nt.properties.length > 0 && (
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {nt.properties.map((p) => (
                            <span
                              key={p.name}
                              className="rounded bg-white px-1.5 py-0.5 text-[11px] text-gray-500 ring-1 ring-gray-200"
                              title={`${p.type}${p.identity !== "none" ? ` (${p.identity})` : ""}`}
                            >
                              {p.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {schema.edgeTypes.length > 0 && (
                  <div>
                    <h4 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                      Relationships
                    </h4>
                    {schema.edgeTypes.map((et) => (
                      <div key={et.name} className="mb-1.5">
                        <div className="text-[12px] text-gray-700">
                          <span className="font-medium">{et.name}</span>
                        </div>
                        <div className="text-[11px] text-gray-400">
                          {et.source} → {et.target}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
