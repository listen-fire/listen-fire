// One pass of one run, in a process of its own (main.ts spawns it):
// WASM_BOUNDARY_MODE picks the pass, argv the run. Warms the run up, then
// runs it `iterations` times, garbage-collecting between runs (never during
// one), and prints the per-run medians as one JSON line. The capture pass runs
// once after the warm-up and writes every payload to `--out`.

// First: the loader instantiates the parser as `movement-lang` loads.
import { MODE, captured, jsonTotals, resetTotals, timerCostMs, wasmTotals } from './instrument';

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { routeEngineLogsTo } from '../../public/log';
import { runMovement } from '../../public/movement-engine';
import { RUNS } from './runs';

/** Present under --expose-gc (main.ts passes it). */
const gc: unknown = Reflect.get(globalThis, 'gc');

interface Args {
  run: string;
  warmup: number;
  iterations: number;
  out?: string;
}

function readArgs(argv: string[]): Args {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const run = value('--run');
  if (run === undefined) throw new Error('child: --run <name>');
  return {
    run,
    warmup: Number(value('--warmup') ?? 10),
    iterations: Number(value('--iterations') ?? 20),
    ...(value('--out') !== undefined ? { out: value('--out') } : {}),
  };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Each key's median over the samples. */
function medians(samples: Array<Record<string, number>>): Record<string, number> {
  const keys = new Set(samples.flatMap((s) => Object.keys(s)));
  return Object.fromEntries([...keys].map((k) => [k, median(samples.map((s) => s[k] ?? 0))]));
}

/** What one run's pass measured, flat: `wall`, and the pass's own keys. */
function sample(wallMs: number): Record<string, number> {
  const out: Record<string, number> = { wall: wallMs };
  if (MODE === 'wasm') {
    for (const [name, ms] of Object.entries(wasmTotals.selfMs)) out[`wasm.${name}`] = ms;
    for (const [name, n] of Object.entries(wasmTotals.calls)) out[`calls.${name}`] = n;
    const self = Object.entries(wasmTotals.selfMs);
    const sum = (keep: (name: string) => boolean) => self.filter(([n]) => keep(n)).reduce((t, [, ms]) => t + ms, 0);
    out['wasm.total'] = sum(() => true);
    out['wasm.engine'] = sum((n) => n.startsWith('engine_'));
    out['wasm.buffers'] = sum((n) => n === 'alloc' || n === 'dealloc' || n === 'last_panic');
    out['wasm.checker'] = out['wasm.total'] - out['wasm.engine'] - out['wasm.buffers'];
    out['env.ms'] = wasmTotals.envMs;
    out['env.calls'] = wasmTotals.envCalls;
    out.frames = wasmTotals.frames;
  }
  if (MODE === 'json') {
    for (const [bucket, ops] of Object.entries(jsonTotals.ms)) {
      for (const [op, ms] of Object.entries(ops)) out[`json.${bucket}.${op}`] = ms;
    }
    for (const [bucket, ops] of Object.entries(jsonTotals.ops)) {
      for (const [op, n] of Object.entries(ops)) out[`ops.${bucket}.${op}`] = n;
    }
    let total = 0;
    for (const [bucket, ops] of Object.entries(jsonTotals.ms)) {
      const inBucket = Object.values(ops).reduce((t, ms) => t + ms, 0);
      out[`json.${bucket}`] = inBucket;
      total += inBucket;
    }
    out['json.total'] = total;
    out.unmatched = jsonTotals.unmatched;
  }
  return out;
}

async function main(): Promise<void> {
  routeEngineLogsTo(({ level, message }) => {
    if (level === 'error' || level === 'warn') process.stderr.write(`${level}: ${message}\n`);
  });
  const args = readArgs(process.argv.slice(2));
  const run = RUNS.find((r) => r.name === args.run);
  if (run === undefined) throw new Error(`child: no run ${args.run} (${RUNS.map((r) => r.name).join(', ')})`);
  const once = async (): Promise<number> => {
    const input = run.input();
    resetTotals();
    captured.length = 0;
    const start = performance.now();
    const result = await runMovement(input);
    const wall = performance.now() - start;
    if (result.writes.length !== run.writes) {
      throw new Error(`run ${run.name} made ${result.writes.length} writes, not ${run.writes}`);
    }
    return wall;
  };
  for (let i = 0; i < args.warmup; i += 1) await once();
  if (MODE === 'capture') {
    if (args.out === undefined) throw new Error('child: the capture pass needs --out <dir>');
    await once();
    mkdirSync(args.out, { recursive: true });
    writeFileSync(path.join(args.out, `${run.name}.json`), JSON.stringify({ run: run.name, calls: captured }));
    process.stdout.write(`${JSON.stringify({ run: run.name, mode: MODE, calls: captured.length })}\n`);
    return;
  }
  const samples: Array<Record<string, number>> = [];
  for (let i = 0; i < args.iterations; i += 1) {
    if (typeof gc === 'function') gc();
    samples.push(sample(await once()));
  }
  process.stdout.write(
    `${JSON.stringify({ run: run.name, mode: MODE, iterations: args.iterations, timerMs: timerCostMs(), medians: medians(samples) })}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
