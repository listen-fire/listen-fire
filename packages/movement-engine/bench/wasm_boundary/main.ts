// How much of a movement run is JSON at the wasm boundary: the benchmark's
// one command (scripts/bench-wasm-boundary.sh runs this). For each
// representative run (runs.ts) it
//
//  1. captures every boundary payload (a capture pass, child.ts);
//  2. times the run whole, the wasm calls in it, and the JavaScript-side JSON
//     on its boundary payloads, each in a process of its own (instrument.ts);
//  3. replays the captured payloads through the Rust side's JSON work
//     (crates/movement-engine/examples/wasm_boundary_replay.rs), natively and
//     built for wasm32 under this Node;
//
// then prints the table and writes everything to
// target/wasm-boundary-bench/results.json. Captures land beside it, never in
// the tree. The wasm32 build of the replay has a target directory of its own
// there, removed when the benchmark ends (`--keep-wasm-target` keeps it).
//
//   scripts/bench-wasm-boundary.sh [--runs small,walk] [--iterations 30]
//     [--warmup 15] [--no-wasm-replay] [--keep-wasm-target]

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { CapturedCall } from './instrument';
import { RUNS } from './runs';

declare const WebAssembly: {
  Module: new (bytes: Uint8Array) => object;
  Instance: new (module: object, imports: object) => { exports: Record<string, unknown> };
};

const ROOT = path.resolve(__dirname, '../../../..');
const OUT = path.join(ROOT, 'target/wasm-boundary-bench');
const CAPTURES = path.join(OUT, 'capture');
const WASM_TARGET = path.join(OUT, 'wasm-target');
const CHILD = path.join(__dirname, 'child.ts');
/** tsx, from the module kit, as the module benches run their sources. */
const TSX = require.resolve('tsx/cjs', { paths: [require.resolve('module-kit/package.json')] });
const EXAMPLE = 'wasm_boundary_replay';

interface Options {
  runs: string[];
  iterations: number;
  warmup: number;
  wasmReplay: boolean;
  keepWasmTarget: boolean;
}

function readOptions(argv: string[]): Options {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const runs = value('--runs')?.split(',') ?? RUNS.map((r) => r.name);
  for (const name of runs) if (!RUNS.some((r) => r.name === name)) throw new Error(`no run ${name}`);
  return {
    runs,
    iterations: Number(value('--iterations') ?? 30),
    warmup: Number(value('--warmup') ?? 15),
    wasmReplay: !argv.includes('--no-wasm-replay'),
    keepWasmTarget: argv.includes('--keep-wasm-target'),
  };
}

function say(line: string): void {
  process.stderr.write(`${line}\n`);
}

function run(command: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited ${result.status ?? result.signal}`);
  return result.stdout;
}

interface PassResult {
  run: string;
  mode: string;
  iterations: number;
  timerMs: number;
  medians: Record<string, number>;
}

function isPassResult(value: unknown): value is PassResult {
  return typeof value === 'object' && value !== null && 'medians' in value && 'timerMs' in value;
}

function pass(mode: 'clean' | 'wasm' | 'json' | 'capture', name: string, options: Options): PassResult | undefined {
  // A capture is of a warm run: what is captured is the same either way,
  // so two warm-ups do.
  const args = ['--expose-gc', '--require', TSX, CHILD, '--run', name];
  if (mode === 'capture') args.push('--warmup', '2', '--out', CAPTURES);
  else args.push('--warmup', String(options.warmup), '--iterations', String(options.iterations));
  const stdout = run(process.execPath, args, { WASM_BOUNDARY_MODE: mode });
  if (mode === 'capture') return undefined;
  const parsed: unknown = JSON.parse(stdout.trim().split('\n').pop() ?? '');
  if (!isPassResult(parsed)) throw new Error(`the ${mode} pass of ${name} printed no result`);
  return parsed;
}

// ── The Rust replay ───────────────────────────────────────────────────────────

interface ReplayResult {
  run: string;
  target: string;
  ms: Record<string, number>;
  envCalls: number;
}

function isReplayResult(value: unknown): value is ReplayResult {
  return typeof value === 'object' && value !== null && 'ms' in value && 'target' in value;
}

function buildNativeReplay(): string {
  say('building the native replay (cargo, release profile)…');
  run('cargo', ['build', '--locked', '--release', '--example', EXAMPLE, '-p', 'listen-fire-engine']);
  return path.join(ROOT, 'target/release/examples', EXAMPLE);
}

/** Built as scripts/build-movement-wasm.sh builds the artifact (the release
 *  profile, its macOS linker wrapper), into a target directory of its own. */
function buildWasmReplay(): string {
  say('building the wasm32 replay (cargo, release profile, its own target directory)…');
  const sysroot = run('rustc', ['--print', 'sysroot']).trim();
  const env: Record<string, string> = { CARGO_TARGET_DIR: WASM_TARGET };
  if (process.platform === 'darwin') {
    const host = /^host: (.*)$/m.exec(run('rustc', ['-vV']))?.[1];
    if (host === undefined) throw new Error('rustc -vV names no host');
    const linkerDir = path.join(WASM_TARGET, 'macos-linker');
    mkdirSync(linkerDir, { recursive: true });
    const linker = path.join(linkerDir, 'rust-lld');
    writeFileSync(linker, `#!/bin/sh\nDYLD_LIBRARY_PATH="${sysroot}/lib" exec "${sysroot}/lib/rustlib/${host}/bin/rust-lld" "$@"\n`, { mode: 0o755 });
    env.CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER = linker;
  }
  run('cargo', ['build', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--example', EXAMPLE, '-p', 'listen-fire-engine'], env);
  return path.join(WASM_TARGET, 'wasm32-unknown-unknown/release/examples', `${EXAMPLE}.wasm`);
}

function nativeReplay(binary: string, capture: string): ReplayResult {
  const parsed: unknown = JSON.parse(run(binary, [capture]).trim());
  if (!isReplayResult(parsed)) throw new Error('the native replay printed no result');
  return parsed;
}

function wasmReplay(module: object, capture: string): ReplayResult {
  const input = readFileSync(capture);
  let memory: Uint8Array | undefined;
  const bytes = (): Uint8Array => {
    if (memory === undefined || memory.byteLength === 0) {
      const exported = instance.exports.memory;
      const buffer: unknown = typeof exported === 'object' && exported !== null ? Reflect.get(exported, 'buffer') : undefined;
      if (!(buffer instanceof ArrayBuffer)) throw new Error('the replay exports no memory');
      memory = new Uint8Array(buffer);
    }
    return memory;
  };
  let printed = '';
  const instance = new WebAssembly.Instance(module, {
    bench: {
      now: () => performance.now(),
      input_len: () => input.length,
      input_read: (ptr: number) => {
        memory = undefined;
        bytes().set(input, ptr);
      },
      output: (ptr: number, len: number) => {
        memory = undefined;
        printed = new TextDecoder().decode(bytes().subarray(ptr, ptr + len));
      },
    },
    movement_env: {
      call: () => {
        throw new Error('the replay asks no environment service');
      },
    },
  });
  const main = instance.exports.main;
  if (typeof main !== 'function') throw new Error('the replay exports no main');
  main(0, 0);
  const parsed: unknown = JSON.parse(printed);
  if (!isReplayResult(parsed)) throw new Error('the wasm replay printed no result');
  return parsed;
}

// ── Payload sizes ─────────────────────────────────────────────────────────────

interface Traffic {
  calls: number;
  /** Bytes JavaScript hands the wasm, and the wasm hands back. */
  inBytes: number;
  outBytes: number;
  maxIn: number;
  maxOut: number;
}

type Kind = 'engine_start' | 'engine_answer' | 'env' | 'checker';

function traffic(calls: CapturedCall[]): Record<Kind, Traffic> {
  const zero = (): Traffic => ({ calls: 0, inBytes: 0, outBytes: 0, maxIn: 0, maxOut: 0 });
  const out: Record<Kind, Traffic> = { engine_start: zero(), engine_answer: zero(), env: zero(), checker: zero() };
  const add = (kind: Kind, inBytes: number, outBytes: number) => {
    const t = out[kind];
    t.calls += 1;
    t.inBytes += inBytes;
    t.outBytes += outBytes;
    t.maxIn = Math.max(t.maxIn, inBytes);
    t.maxOut = Math.max(t.maxOut, outBytes);
  };
  const size = (text: string | undefined) => (text === undefined ? 0 : Buffer.byteLength(text, 'utf8'));
  for (const call of calls) {
    if (call.export === 'engine_finish') continue;
    const kind: Kind = call.export === 'engine_start' || call.export === 'engine_answer' ? call.export : 'checker';
    add(kind, call.inputs.reduce((t, i) => t + size(i), 0), size(call.output));
    // An environment call's request goes out of the wasm, its reply in.
    for (const env of call.env) add('env', size(env.reply), size(env.request));
  }
  return out;
}

// ── The table ─────────────────────────────────────────────────────────────────

interface RunReport {
  name: string;
  why: string;
  clean: PassResult;
  wasm: PassResult;
  json: PassResult;
  native: ReplayResult;
  wasm32?: ReplayResult;
  traffic: Record<Kind, Traffic>;
}

const ms = (value: number) => `${value.toFixed(3).padStart(9)} ms`;
const pct = (part: number, whole: number) => `${((100 * part) / whole).toFixed(1).padStart(5)} %`;
const kb = (bytes: number) => (bytes >= 10_000 ? `${(bytes / 1024).toFixed(1)} KiB` : `${bytes} B`);
const sum = (values: Record<string, number>) => Object.values(values).reduce((t, v) => t + v, 0);

function table(report: RunReport): string {
  const m = (pass: PassResult, key: string) => pass.medians[key] ?? 0;
  const wall = m(report.clean, 'wall');
  const wasmSelf = m(report.wasm, 'wasm.total');
  const jsJson = m(report.json, 'json.total');
  const rustNative = sum(report.native.ms);
  const rustWasm = report.wasm32 === undefined ? undefined : sum(report.wasm32.ms);
  const rust = rustWasm ?? rustNative;
  const lines: string[] = [];
  lines.push(`── ${report.name}: ${report.why}`);
  lines.push('  calls and payloads (one run)');
  for (const [kind, t] of Object.entries(report.traffic)) {
    if (t.calls === 0) continue;
    lines.push(
      `    ${kind.padEnd(14)} ${String(t.calls).padStart(5)} calls   in ${kb(t.inBytes).padStart(10)} (max ${kb(t.maxIn)})   out ${kb(t.outBytes).padStart(10)} (max ${kb(t.maxOut)})`,
    );
  }
  lines.push('  time (median of iterations, warm)');
  lines.push(`    wall, uninstrumented        ${ms(wall)}`);
  lines.push(`    inside wasm (self)          ${ms(wasmSelf)}  ${pct(wasmSelf, wall)}   (instrumented wall ${ms(m(report.wasm, 'wall')).trim()})`);
  lines.push(`      engine segment calls      ${ms(m(report.wasm, 'wasm.engine'))}`);
  lines.push(`      parser and checker calls  ${ms(m(report.wasm, 'wasm.checker'))}`);
  lines.push(`      alloc and dealloc         ${ms(m(report.wasm, 'wasm.buffers'))}`);
  lines.push(`    JavaScript (the rest)       ${ms(wall - wasmSelf)}  ${pct(wall - wasmSelf, wall)}`);
  lines.push(`      environment services      ${ms(m(report.wasm, 'env.ms'))}   (${m(report.wasm, 'env.calls')} calls, JSON included)`);
  lines.push(`    JavaScript JSON + UTF-8     ${ms(jsJson)}  ${pct(jsJson, wall)}   (instrumented wall ${ms(m(report.json, 'wall')).trim()})`);
  for (const bucket of ['engine', 'env', 'checker']) {
    const ops = ['stringify', 'parse', 'encode', 'decode'].map((op) => `${op} ${m(report.json, `json.${bucket}.${op}`).toFixed(3)}`);
    lines.push(`      ${bucket.padEnd(24)}${ms(m(report.json, `json.${bucket}`))}   (${ops.join(', ')})`);
  }
  lines.push(`    Rust JSON, native replay    ${ms(rustNative)}  ${pct(rustNative, wall)}`);
  if (rustWasm !== undefined) lines.push(`    Rust JSON, wasm32 replay    ${ms(rustWasm)}  ${pct(rustWasm, wall)}`);
  const parts = report.wasm32?.ms ?? report.native.ms;
  for (const [key, value] of Object.entries(parts)) if (value > 0) lines.push(`      ${key.padEnd(24)}${ms(value)}`);
  lines.push(`  JSON's share of wall time     ${pct(jsJson + rust, wall)}   (JavaScript ${pct(jsJson, wall).trim()}, Rust ${pct(rust, wall).trim()}${rustWasm === undefined ? ', native replay: not the build production runs' : ''})`);
  lines.push(`  Rust JSON's share of wasm     ${pct(rust, wasmSelf)}`);
  if (m(report.json, 'unmatched') > 0) lines.push(`  ! ${m(report.json, 'unmatched')} boundary inputs had no encode the JSON pass could attribute`);
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = readOptions(process.argv.slice(2));
  mkdirSync(CAPTURES, { recursive: true });
  const native = buildNativeReplay();
  const wasmModule = options.wasmReplay ? new WebAssembly.Module(readFileSync(buildWasmReplay())) : undefined;
  const reports: RunReport[] = [];
  try {
    for (const name of options.runs) {
      const bench = RUNS.find((r) => r.name === name);
      if (bench === undefined) throw new Error(`no run ${name}`);
      say(`${name}: capture, then the clean, wasm and json passes, then the replays…`);
      pass('capture', name, options);
      const capture = path.join(CAPTURES, `${name}.json`);
      const calls: unknown = JSON.parse(readFileSync(capture, 'utf8')).calls;
      if (!Array.isArray(calls)) throw new Error(`${capture} holds no calls`);
      const [clean, wasm, json] = (['clean', 'wasm', 'json'] as const).map((mode) => {
        const result = pass(mode, name, options);
        if (result === undefined) throw new Error(`the ${mode} pass of ${name} returned nothing`);
        return result;
      });
      reports.push({
        name,
        why: bench.why,
        clean,
        wasm,
        json,
        native: nativeReplay(native, capture),
        ...(wasmModule !== undefined ? { wasm32: wasmReplay(wasmModule, capture) } : {}),
        traffic: traffic(calls),
      });
    }
  } finally {
    if (!options.keepWasmTarget && existsSync(WASM_TARGET)) rmSync(WASM_TARGET, { recursive: true, force: true });
  }
  writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ when: new Date().toISOString(), options, node: process.version, reports }, null, 2));
  process.stdout.write(`${reports.map(table).join('\n\n')}\n\n(results: ${path.relative(ROOT, path.join(OUT, 'results.json'))})\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
