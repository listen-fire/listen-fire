// What the boundary benchmark observes, from outside the product code: it
// replaces `WebAssembly.Instance` (so every instance the loader makes, the
// parser's and each engine segment's, hands out wrapped exports and gets a
// wrapped `movement_env.call`), and in the JSON pass `JSON.parse`,
// `JSON.stringify` and UTF-8 encode/decode. It must be imported before
// `movement-lang`: the loader instantiates the parser as it loads.
//
// One pass per process, chosen by WASM_BOUNDARY_MODE, so no pass's
// observation weighs on another's numbers:
//
//  - clean:   nothing replaced; the wall time alone.
//  - wasm:    each export call and each environment call timed, self time
//             (an export's time less the environment calls inside it).
//  - json:    the JSON and UTF-8 work on boundary payloads timed where it
//             happens (attribution below), nothing else.
//  - capture: every payload copied out, for the Rust replay; nothing timed.
//
// Attribution in the JSON pass. An input is encoded, then `alloc`ed, then
// the export is called: the encode whose byte length matches an input's
// allocation since the previous export call is the input's, and the
// stringify whose result is that very text is its JSON. An output is decoded
// right after its export returns, and the parse of exactly that text is its
// JSON. Inside an environment call everything is the call's.

declare const WebAssembly: {
  Instance: new (module: unknown, imports: Record<string, Record<string, unknown>>) => { exports: Record<string, unknown> };
};

export type Mode = 'clean' | 'wasm' | 'json' | 'capture';

function readMode(value: string | undefined): Mode {
  switch (value) {
    case undefined:
    case 'clean':
      return 'clean';
    case 'wasm':
    case 'json':
    case 'capture':
      return value;
    default:
      throw new Error(`WASM_BOUNDARY_MODE is clean, wasm, json or capture, not ${value}`);
  }
}

export const MODE: Mode = readMode(process.env.WASM_BOUNDARY_MODE);

const now = (): number => performance.now();

/** Where a call's time and payloads are counted. */
export type Bucket = 'engine' | 'env' | 'checker';

const BUFFER_EXPORTS = new Set(['alloc', 'dealloc', 'last_panic']);
const ENGINE_EXPORTS = new Set(['engine_start', 'engine_answer', 'engine_finish']);

const bucketOf = (name: string): Bucket => (ENGINE_EXPORTS.has(name) ? 'engine' : 'checker');

// ── Accumulators ──────────────────────────────────────────────────────────────

export interface WasmTotals {
  /** Self time inside wasm, ms, by export (buffer management included). */
  selfMs: Record<string, number>;
  calls: Record<string, number>;
  /** The environment calls' self time in JavaScript, ms. */
  envMs: number;
  envCalls: number;
  /** Timed frames: each costs about one timer read of overhead. */
  frames: number;
}

export interface JsonTotals {
  /** ms, by bucket and operation. */
  ms: Record<Bucket, Record<JsonOp, number>>;
  ops: Record<Bucket, Record<JsonOp, number>>;
  /** Boundary inputs and outputs the attribution could not match (should be 0). */
  unmatched: number;
}

export type JsonOp = 'stringify' | 'parse' | 'encode' | 'decode';

const zeroOps = (): Record<JsonOp, number> => ({ stringify: 0, parse: 0, encode: 0, decode: 0 });

export const wasmTotals: WasmTotals = { selfMs: {}, calls: {}, envMs: 0, envCalls: 0, frames: 0 };
export const jsonTotals: JsonTotals = {
  ms: { engine: zeroOps(), env: zeroOps(), checker: zeroOps() },
  ops: { engine: zeroOps(), env: zeroOps(), checker: zeroOps() },
  unmatched: 0,
};

export function resetTotals(): void {
  wasmTotals.selfMs = {};
  wasmTotals.calls = {};
  wasmTotals.envMs = 0;
  wasmTotals.envCalls = 0;
  wasmTotals.frames = 0;
  for (const bucket of ['engine', 'env', 'checker'] as const) {
    jsonTotals.ms[bucket] = zeroOps();
    jsonTotals.ops[bucket] = zeroOps();
  }
  jsonTotals.unmatched = 0;
}

function addJson(bucket: Bucket, op: JsonOp, ms: number): void {
  jsonTotals.ms[bucket][op] += ms;
  jsonTotals.ops[bucket][op] += 1;
}

// ── Capture ───────────────────────────────────────────────────────────────────

export interface CapturedEnvCall {
  request: string;
  reply: string;
  status: number;
}

export interface CapturedCall {
  export: string;
  /** The scalar arguments besides the buffers (engine_answer's id). */
  scalars: number[];
  inputs: string[];
  /** Absent for an export that writes no output (engine_finish). */
  output?: string;
  status?: number;
  env: CapturedEnvCall[];
}

export const captured: CapturedCall[] = [];

const exactDecoder = new TextDecoder('utf-8', { fatal: true });

// ── Timed frames (wasm pass) ──────────────────────────────────────────────────

interface Frame {
  start: number;
  child: number;
}

const frames: Frame[] = [];

function enter(): void {
  frames.push({ start: now(), child: 0 });
}

/** The frame's self time. */
function leave(): number {
  const frame = frames.pop();
  if (frame === undefined) throw new Error('bench: a frame left that never entered');
  const total = now() - frame.start;
  const parent = frames[frames.length - 1];
  if (parent !== undefined) parent.child += total;
  wasmTotals.frames += 1;
  return total - frame.child;
}

// ── JSON attribution state (json pass) ────────────────────────────────────────

interface Pending<T> {
  value: T;
  ms: number;
}

const PENDING_LIMIT = 32;
let pendingStringify: Array<Pending<string>> = [];
let pendingEncode: Array<Pending<{ text: string; bytes: number }>> = [];
let allocsSinceCall: Array<{ ptr: number; len: number }> = [];
let inEnv = false;
let expectDecode: Bucket | undefined;
let expectParse: { bucket: Bucket; text: string } | undefined;

function remember<T>(list: Array<Pending<T>>, entry: Pending<T>): void {
  list.push(entry);
  if (list.length > PENDING_LIMIT) list.shift();
}

/** At an export call: which pending encodes (and their stringifies) were
 *  its inputs. */
function attributeInputs(bucket: Bucket, inputs: Array<{ ptr: number; len: number }>): void {
  for (const input of inputs) {
    const at = findLast(pendingEncode, (e) => e.value.bytes === input.len);
    if (at === -1) {
      jsonTotals.unmatched += 1;
      continue;
    }
    const [encode] = pendingEncode.splice(at, 1);
    addJson(bucket, 'encode', encode.ms);
    const json = findLast(pendingStringify, (s) => s.value === encode.value.text);
    if (json !== -1) {
      const [stringify] = pendingStringify.splice(json, 1);
      addJson(bucket, 'stringify', stringify.ms);
    }
  }
  pendingEncode = [];
  pendingStringify = [];
}

function findLast<T>(list: T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (test(list[i])) return i;
  return -1;
}

function installJsonHooks(): void {
  const realStringify = JSON.stringify;
  const realParse = JSON.parse;
  const realEncode = TextEncoder.prototype.encode;
  const realDecode = TextDecoder.prototype.decode;
  Reflect.set(JSON, 'stringify', (...args: unknown[]): unknown => {
    const start = now();
    const result: unknown = Reflect.apply(realStringify, JSON, args);
    const ms = now() - start;
    if (inEnv) addJson('env', 'stringify', ms);
    else if (typeof result === 'string') remember(pendingStringify, { value: result, ms });
    return result;
  });
  Reflect.set(JSON, 'parse', (...args: unknown[]): unknown => {
    const text = args[0];
    const expected = expectParse;
    if (!inEnv && (expected === undefined || text !== expected.text)) return Reflect.apply(realParse, JSON, args);
    const start = now();
    const result: unknown = Reflect.apply(realParse, JSON, args);
    const ms = now() - start;
    if (inEnv) addJson('env', 'parse', ms);
    else if (expected !== undefined) {
      addJson(expected.bucket, 'parse', ms);
      expectParse = undefined;
    }
    return result;
  });
  Reflect.set(TextEncoder.prototype, 'encode', function (this: TextEncoder, ...args: unknown[]): unknown {
    const start = now();
    const result: unknown = Reflect.apply(realEncode, this, args);
    const ms = now() - start;
    const text = args[0];
    if (inEnv) addJson('env', 'encode', ms);
    else if (typeof text === 'string' && result instanceof Uint8Array) {
      remember(pendingEncode, { value: { text, bytes: result.length }, ms });
    }
    return result;
  });
  Reflect.set(TextDecoder.prototype, 'decode', function (this: TextDecoder, ...args: unknown[]): unknown {
    const bucket = inEnv ? 'env' : expectDecode;
    if (bucket === undefined) return Reflect.apply(realDecode, this, args);
    const start = now();
    const result: unknown = Reflect.apply(realDecode, this, args);
    const ms = now() - start;
    addJson(bucket, 'decode', ms);
    if (!inEnv) {
      expectDecode = undefined;
      if (typeof result === 'string') expectParse = { bucket, text: result };
    }
    return result;
  });
}

// ── The instance wrapper ──────────────────────────────────────────────────────

type WasmFunction = (...args: number[]) => unknown;

function memoryOf(exports: Record<string, unknown>): Uint8Array {
  const memory = exports.memory;
  const buffer: unknown = typeof memory === 'object' && memory !== null ? Reflect.get(memory, 'buffer') : undefined;
  if (!(buffer instanceof ArrayBuffer)) throw new Error('bench: the instance exports no memory');
  return new Uint8Array(buffer);
}

function u32At(exports: Record<string, unknown>, at: number): number {
  const bytes = memoryOf(exports);
  return new DataView(bytes.buffer).getUint32(at, true);
}

function text(exports: Record<string, unknown>, ptr: number, len: number): string {
  return exactDecoder.decode(memoryOf(exports).slice(ptr, ptr + len));
}

function wrapExport(name: string, fn: WasmFunction, exportsOf: () => Record<string, unknown>): WasmFunction {
  if (BUFFER_EXPORTS.has(name)) {
    return (...args) => {
      if (MODE === 'wasm') enter();
      const result = fn(...args);
      if (MODE === 'wasm') {
        wasmTotals.selfMs[name] = (wasmTotals.selfMs[name] ?? 0) + leave();
        wasmTotals.calls[name] = (wasmTotals.calls[name] ?? 0) + 1;
      }
      if (name === 'alloc' && !inEnv && typeof result === 'number') allocsSinceCall.push({ ptr: result, len: args[0] });
      return result;
    };
  }
  const bucket = bucketOf(name);
  return (...args) => {
    // The inputs are every allocation since the previous call but the last,
    // which is the two out slots (loader.ts `exchange`).
    const allocs = allocsSinceCall;
    allocsSinceCall = [];
    const writesOutput = args.length >= 2;
    const inputs = writesOutput ? allocs.slice(0, -1) : [];
    if (MODE === 'json') attributeInputs(bucket, inputs);
    let call: CapturedCall | undefined;
    if (MODE === 'capture') {
      const exports = exportsOf();
      // engine_answer's id comes before its buffer; every other export's
      // scalars come after its buffers (loader.ts).
      const scalars = name === 'engine_answer' ? args.slice(0, 1) : args.slice(2 * inputs.length, writesOutput ? -2 : undefined);
      call = {
        export: name,
        scalars,
        inputs: inputs.map((i) => text(exports, i.ptr, i.len)),
        env: [],
      };
      captured.push(call);
    }
    if (MODE === 'wasm') enter();
    const result = fn(...args);
    if (MODE === 'wasm') {
      wasmTotals.selfMs[name] = (wasmTotals.selfMs[name] ?? 0) + leave();
      wasmTotals.calls[name] = (wasmTotals.calls[name] ?? 0) + 1;
    }
    if (MODE === 'json' && writesOutput) expectDecode = bucket;
    if (call !== undefined && writesOutput) {
      const exports = exportsOf();
      const [outPtrPtr, outLenPtr] = args.slice(-2);
      call.output = text(exports, u32At(exports, outPtrPtr), u32At(exports, outLenPtr));
      if (typeof result === 'number') call.status = result;
    }
    return result;
  };
}

function wrapEnvCall(real: WasmFunction, exportsOf: () => Record<string, unknown>): WasmFunction {
  return (requestPtr, requestLen, outPtrPtr, outLenPtr) => {
    const request = MODE === 'capture' ? text(exportsOf(), requestPtr, requestLen) : '';
    if (MODE === 'wasm') enter();
    inEnv = true;
    let status: unknown;
    try {
      status = real(requestPtr, requestLen, outPtrPtr, outLenPtr);
    } finally {
      inEnv = false;
      if (MODE === 'wasm') {
        wasmTotals.envMs += leave();
        wasmTotals.envCalls += 1;
      }
    }
    if (MODE === 'capture') {
      const exports = exportsOf();
      const reply = text(exports, u32At(exports, outPtrPtr), u32At(exports, outLenPtr));
      const into = captured[captured.length - 1];
      if (into === undefined) throw new Error('bench: an environment call outside any export call');
      into.env.push({ request, reply, status: typeof status === 'number' ? status : -1 });
    }
    return status;
  };
}

function installInstanceHook(): void {
  const RealInstance = WebAssembly.Instance;
  function BenchInstance(module: unknown, imports: Record<string, Record<string, unknown>>): { exports: Record<string, unknown> } {
    let raw: Record<string, unknown> | undefined;
    const exportsOf = (): Record<string, unknown> => {
      if (raw === undefined) throw new Error('bench: the instance called out while instantiating');
      return raw;
    };
    const wrappedImports: Record<string, Record<string, unknown>> = {};
    for (const [moduleName, fields] of Object.entries(imports)) {
      wrappedImports[moduleName] = { ...fields };
      const call = fields.call;
      if (moduleName === 'movement_env' && typeof call === 'function') {
        wrappedImports[moduleName].call = wrapEnvCall((...args) => Reflect.apply(call, undefined, args), exportsOf);
      }
    }
    raw = new RealInstance(module, wrappedImports).exports;
    const exports: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(raw)) {
      exports[name] =
        typeof value === 'function' ? wrapExport(name, (...args) => Reflect.apply(value, undefined, args), exportsOf) : value;
    }
    return { exports };
  }
  Reflect.set(WebAssembly, 'Instance', BenchInstance);
}

if (MODE !== 'clean') installInstanceHook();
if (MODE === 'json') installJsonHooks();

/** One timer read's cost, ms: the floor under every timed frame or op. */
export function timerCostMs(): number {
  const samples: number[] = [];
  for (let i = 0; i < 2000; i += 1) {
    const a = now();
    const b = now();
    samples.push(b - a);
  }
  samples.sort((x, y) => x - y);
  return samples[samples.length >> 1];
}
