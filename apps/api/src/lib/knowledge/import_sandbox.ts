import { newAsyncContext, type QuickJSAsyncContext } from 'quickjs-emscripten';
import { parse } from 'csv-parse/sync';

// sandbox runner using quickjs-emscripten (async)

export type NodeRef = { id: string; type: string };

export interface CollectedNode {
  id: string;
  type: string;
  properties: Record<string, unknown>;
}

export interface CollectedEdge {
  type: string;
  sourceId: string;
  targetId: string;
}

export interface SandboxResult {
  success: boolean;
  error?: string;
  nodes: CollectedNode[];
  edges: CollectedEdge[];
  logs: string[];
}

export type HostFn = (arg: string) => Promise<string>;

function formatQuickJSError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const e = err as Record<string, unknown>;
    const message = e.message ? String(e.message) : String(err);
    const stack = e.stack ? String(e.stack) : '';
    return stack ? `${message}\n${stack}` : message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Default host functions (in-memory record-keeping)
// ---------------------------------------------------------------------------

function defaultHostFunctions(options: {
  nodes: CollectedNode[];
  edges: CollectedEdge[];
  logs: string[];
  nodeIndex: Map<string, CollectedNode>;
  maxNodes: number;
  nextId: { value: number };
}): Record<string, HostFn> {
  const { nodes, edges, logs, nodeIndex, maxNodes, nextId } = options;

  function nodeKey(type: string, props: Record<string, unknown>): string {
    const sorted = Object.entries(props).sort(([a], [b]) => a.localeCompare(b));
    return `${type}::${JSON.stringify(sorted)}`;
  }

  return {
    createNode: async (argsJson: string) => {
      const { type, properties } = JSON.parse(argsJson) as { type: string; properties: Record<string, unknown> };
      const key = nodeKey(type, properties);
      const existing = nodeIndex.get(key);
      if (existing) return JSON.stringify({ id: existing.id, type: existing.type });

      const id = `import-${nextId.value++}`;
      const node: CollectedNode = { id, type, properties: { ...properties } };
      if (nodes.length < maxNodes) {
        nodes.push(node);
      }
      nodeIndex.set(key, node);
      return JSON.stringify({ id, type });
    },

    createEdge: async (argsJson: string) => {
      const { type, source, target } = JSON.parse(argsJson) as { type: string; source: NodeRef; target: NodeRef };
      edges.push({ type, sourceId: source.id, targetId: target.id });
      return '{}';
    },

    findNode: async (argsJson: string) => {
      const { type, identityProps } = JSON.parse(argsJson) as { type: string; identityProps: Record<string, unknown> };
      const key = nodeKey(type, identityProps);
      const found = nodeIndex.get(key);
      return found ? JSON.stringify({ id: found.id, type: found.type }) : 'null';
    },

    parseCSV: async (argsJson: string) => {
      const { text, options: opts } = JSON.parse(argsJson) as { text: string; options?: { delimiter?: string } };
      return JSON.stringify(parse(text, {
        columns: true as const,
        delimiter: opts?.delimiter ?? ',',
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      }));
    },

    parseTSV: async (textArg: string) => {
      return JSON.stringify(parse(textArg, {
        columns: true as const,
        delimiter: '\t',
        skip_empty_lines: true,
        trim: true,
        relax_column_count: true,
      }));
    },

    parseJSON: async (textArg: string) => {
      const parsed = JSON.parse(textArg);
      return JSON.stringify(Array.isArray(parsed) ? parsed : [parsed]);
    },

    log: async (argsJson: string) => {
      logs.push(argsJson);
      return '""';
    },
  };
}

// ---------------------------------------------------------------------------
// Register asyncified host functions into a QuickJS async context
// ---------------------------------------------------------------------------

function registerHostFunctions(
  ctx: QuickJSAsyncContext,
  hostFns: Record<string, HostFn>,
): Array<{ dispose(): void }> {
  const handles: Array<{ dispose(): void }> = [];
  const MAX_ARG_SIZE = 10_000_000; // 10 MB

  for (const [name, impl] of Object.entries(hostFns)) {
    const hostName = `__host_${name}`;
    // Asyncified functions must NEVER throw — the WASM runtime can't propagate
    // errors while the stack is suspended. Instead, return errors as JSON and
    // let the bootstrap wrapper convert them to QJS exceptions.
    const fn = ctx.newAsyncifiedFunction(hostName, async (argHandle) => {
      try {
        const arg = ctx.getString(argHandle);
        if (arg.length > MAX_ARG_SIZE) {
          return ctx.newString(JSON.stringify({ __error: `Argument to ${hostName} too large (${arg.length} bytes, max ${MAX_ARG_SIZE})` }));
        }
        const result = await impl(arg);
        return ctx.newString(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return ctx.newString(JSON.stringify({ __error: msg }));
      }
    });
    ctx.setProp(ctx.global, hostName, fn);
    handles.push(fn);
  }

  return handles;
}

// ---------------------------------------------------------------------------
// Bootstrap: wrap __host_* functions with user-friendly API
// ---------------------------------------------------------------------------

const BOOTSTRAP = `
function __check(r) { if (r && r.__error) throw new Error(r.__error); return r; }
globalThis.parseCSV = function(text, opts) { return __check(JSON.parse(__host_parseCSV(JSON.stringify({ text: text, options: opts || {} })))); };
globalThis.parseTSV = function(text) { return __check(JSON.parse(__host_parseTSV(text))); };
globalThis.parseJSON = function(text) { return __check(JSON.parse(__host_parseJSON(text))); };
globalThis.createNode = function(type, props) { return __check(JSON.parse(__host_createNode(JSON.stringify({ type: type, properties: props || {} })))); };
globalThis.createEdge = function(type, source, target) { __check(JSON.parse(__host_createEdge(JSON.stringify({ type: type, source: source, target: target })))); };
globalThis.findNode = function(type, identityProps) { var r = JSON.parse(__host_findNode(JSON.stringify({ type: type, identityProps: identityProps || {} }))); if (r && r.__error) throw new Error(r.__error); return r === null ? null : r; };
globalThis.console = { log: function() { __host_log(Array.prototype.slice.call(arguments).map(function(a) { return typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' ')); } };
if (typeof __host_query !== 'undefined') {
  globalThis.query = function(sqlText) { return __check(JSON.parse(__host_query(sqlText))); };
}
if (typeof __host_mergeNodes !== 'undefined') {
  globalThis.mergeNodes = function(targetId, sourceId) { return __check(JSON.parse(__host_mergeNodes(JSON.stringify({ targetNodeId: targetId, sourceNodeId: sourceId })))); };
}
if (typeof __host_createEntity !== 'undefined') {
  globalThis.createEntity = function(typeName, properties) { return __check(JSON.parse(__host_createEntity(JSON.stringify({ typeName: typeName, properties: properties || {} })))); };
}
if (typeof __host_updateEntity !== 'undefined') {
  globalThis.updateEntity = function(nodeId, properties) { return __check(JSON.parse(__host_updateEntity(JSON.stringify({ nodeId: nodeId, properties: properties || {} })))); };
}
if (typeof __host_deleteEntity !== 'undefined') {
  globalThis.deleteEntity = function(nodeId) { return __check(JSON.parse(__host_deleteEntity(JSON.stringify({ nodeId: nodeId })))); };
}
if (typeof __host_createRelationship !== 'undefined') {
  globalThis.createRelationship = function(sourceNodeId, targetNodeId, relationshipName, properties) { return __check(JSON.parse(__host_createRelationship(JSON.stringify({ sourceNodeId: sourceNodeId, targetNodeId: targetNodeId, relationshipName: relationshipName, properties: properties })))); };
}
if (typeof __host_updateRelationship !== 'undefined') {
  globalThis.updateRelationship = function(edgeId, properties) { return __check(JSON.parse(__host_updateRelationship(JSON.stringify({ edgeId: edgeId, properties: properties || {} })))); };
}
if (typeof __host_deleteRelationship !== 'undefined') {
  globalThis.deleteRelationship = function(sourceNodeId, targetNodeId, relationshipName) { return __check(JSON.parse(__host_deleteRelationship(JSON.stringify({ sourceNodeId: sourceNodeId, targetNodeId: targetNodeId, relationshipName: relationshipName })))); };
}
if (typeof __host_haiku !== 'undefined') {
  globalThis.haiku = function(prompt, options) { return __check(JSON.parse(__host_haiku(JSON.stringify({ prompt: prompt, options: options || {} })))); };
}
if (typeof __host_readFile !== 'undefined') {
  globalThis.readFile = function(index) { return __check(JSON.parse(__host_readFile(JSON.stringify({ index: index })))); };
  globalThis.fileCount = function() { return JSON.parse(__host_fileCount()); };
}
`;

// ---------------------------------------------------------------------------
// Sandbox runner — uses async QuickJS so host functions can do async work
// ---------------------------------------------------------------------------

export async function runInSandbox(
  code: string,
  input: string,
  options?: {
    timeoutMs?: number;
    maxNodes?: number;
    hostFnOverrides?: Partial<Record<string, HostFn>>;
  },
): Promise<SandboxResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const maxNodes = options?.maxNodes ?? Infinity;

  const nodes: CollectedNode[] = [];
  const edges: CollectedEdge[] = [];
  const logs: string[] = [];
  const nodeIndex = new Map<string, CollectedNode>();
  const nextId = { value: 1 };

  const hostFns: Record<string, HostFn> = {
    ...defaultHostFunctions({ nodes, edges, logs, nodeIndex, maxNodes, nextId }),
  };
  if (options?.hostFnOverrides) {
    for (const [k, v] of Object.entries(options.hostFnOverrides)) {
      if (v) hostFns[k] = v;
    }
  }

  const deadline = Date.now() + timeoutMs;
  const ctx = await newAsyncContext();
  ctx.runtime.setMemoryLimit(128 * 1024 * 1024); // 128 MB
  ctx.runtime.setInterruptHandler(() => Date.now() > deadline);

  try {
    const handles = registerHostFunctions(ctx, hostFns);

    // Inject input as a global string
    const inputHandle = ctx.newString(input);
    ctx.setProp(ctx.global, 'input', inputHandle);
    handles.push(inputHandle);

    const bootstrapResult = await ctx.evalCodeAsync(BOOTSTRAP, 'bootstrap.js');
    if (bootstrapResult.error) {
      const err = ctx.dump(bootstrapResult.error);
      bootstrapResult.error.dispose();
      return { success: false, error: `Bootstrap error: ${String(err)}`, nodes, edges, logs };
    }
    bootstrapResult.value.dispose();

    // Run user code directly — no async IIFE needed.
    // Asyncified host functions appear synchronous to QJS; evalCodeAsync
    // handles the WASM-level suspension transparently.  Using an async IIFE
    // with `await` would push subsequent asyncified calls into microtasks
    // processed by executePendingJobs(), which is synchronous and CANNOT
    // handle asyncify suspension — causing "cannot handle error in suspended
    // function" crashes.
    const evalResult = await ctx.evalCodeAsync(code, 'import-script.js');

    if (evalResult.error) {
      const err = ctx.dump(evalResult.error);
      evalResult.error.dispose();
      return { success: false, error: formatQuickJSError(err), nodes, edges, logs };
    }
    evalResult.value.dispose();

    for (const h of handles) h.dispose();

    return { success: true, nodes, edges, logs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? `\n${err.stack}` : '';
    return {
      success: false,
      error: `${message}${stack}`,
      nodes,
      edges,
      logs,
    };
  } finally {
    try { ctx.dispose(); } catch { /* context owns the runtime — disposes both */ }
  }
}
