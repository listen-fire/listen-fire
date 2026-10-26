// A served module's run scopes: what makes a module served as a process keep
// a run's memo and call count as it does in process. The host names the run's
// adapter instance on every call (`cacheScopeId`, one per instance per run
// segment); each call is answered inside the run scope kept for that id, so
// the calls of one run share it and two runs never do.
//
// The protocol has no message that says a run has ended, so a scope is let go
// when no call has touched it for `idleMs`, or when the process keeps `most`
// and another run arrives (the least recently used goes). Letting one go early
// costs only reads the run asks again; it never serves one run another's.

import { RunScope, inRunScope } from 'module-runtime/run_scope';

import type { ModuleLog } from './define';

export interface RunScopes {
  /** Answer `call` inside the run scope `cacheScopeId` names. */
  around<T>(cacheScopeId: string, call: () => Promise<T>): Promise<T>;
  /** How many scopes are kept — diagnostics and tests. */
  open(): number;
}

// The ids hosts send on a call that belongs to no run: lf's and the engine's
// own reads (a manifest, an inbound check) and a slot's calls. One scope for
// either would be shared by every run the process ever serves, so a call
// under one is answered outside any run, as it is in process.
const OUTSIDE_ANY_RUN: ReadonlySet<string> = new Set(['<none>', '<slot>']);

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_MOST = 64;

interface Kept {
  scope: RunScope;
  touched: number;
  inFlight: number;
}

export function runScopes(options: { idleMs?: number; most?: number; now?: () => number } = {}): RunScopes {
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const most = options.most ?? DEFAULT_MOST;
  const now = options.now ?? Date.now;
  // Least recently used first: a touched scope is moved to the end.
  const kept = new Map<string, Kept>();

  const letGoIdle = (at: number): void => {
    for (const [id, entry] of kept) {
      if (entry.inFlight === 0 && at - entry.touched >= idleMs) kept.delete(id);
    }
  };

  const take = (id: string): Kept => {
    const at = now();
    letGoIdle(at);
    const entry = kept.get(id) ?? { scope: new RunScope(), touched: at, inFlight: 0 };
    kept.delete(id);
    // A scope let go while a call is in it is not broken: that call keeps it,
    // and the run's next call starts a fresh one.
    while (kept.size >= most) {
      const oldest = kept.keys().next();
      if (oldest.done === true) break;
      kept.delete(oldest.value);
    }
    entry.touched = at;
    kept.set(id, entry);
    return entry;
  };

  return {
    async around(cacheScopeId, call) {
      if (OUTSIDE_ANY_RUN.has(cacheScopeId)) return call();
      const entry = take(cacheScopeId);
      entry.inFlight += 1;
      try {
        return await inRunScope(entry.scope, call);
      } finally {
        entry.inFlight -= 1;
        entry.touched = now();
      }
    },
    open: () => kept.size,
  };
}

const RUN_SCOPE_FILE = /[\\/]module-runtime[\\/]run_scope\.(?:[cm]?[jt]s)$/;

/** The files of module-runtime's run scope that this process has loaded. The
 *  scope lives in an AsyncLocalStorage each copy of that file creates for
 *  itself, so a module that loaded a different copy than the kit reads a scope
 *  the kit never opens, and its memo and ceiling silently do not exist. */
export function loadedRunScopeFiles(loaded: Iterable<string> = Object.keys(require.cache)): string[] {
  return [...new Set([...loaded].filter((file) => RUN_SCOPE_FILE.test(file)))];
}

/** Say once, at start, when the process holds more than one copy of the run
 *  scope: the kit's scopes then do not reach the module that loaded the other.
 *  Returns whether it said so. */
export function warnIfRunScopesSplit(log: ModuleLog, loaded: Iterable<string> = Object.keys(require.cache)): boolean {
  const copies = loadedRunScopeFiles(loaded);
  if (copies.length < 2) return false;
  log.warn(
    `run scopes cannot reach every module: ${copies.length} copies of module-runtime's run_scope are loaded (${copies.join(', ')}), so a module on a different copy than the kit's has no run cache or call ceiling; install one version of @listen-fire/module-runtime`,
  );
  return true;
}
