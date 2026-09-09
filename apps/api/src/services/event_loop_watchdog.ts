// What the main thread was doing when it stopped answering.
//
// The API is restarted several times a day by the platform's health check: the
// process stops logging, pins a core, keeps its memory flat, and answers
// nothing until it is killed. Flat memory rules out the heap; a pinned core
// with no progress is a blocked event loop, and a blocked event loop cannot
// log what is blocking it — every diagnostic that lives on the loop is queued
// behind the thing we want to see, and is lost outright when the platform
// kills the process before the loop ever comes back.
//
// So the observer lives off the loop. The main thread stamps the current time
// into shared memory every half second; a worker thread reads that stamp, and
// when it stops advancing writes straight to file descriptor 2. Writing to the
// descriptor is the point: a worker's `console` and `process.stderr` are
// forwarded through the PARENT's stream, which is exactly the thing that is
// stuck, so those lines would sit in a queue until the loop recovered — or
// vanish with the process.
//
// Two stalls' worth of lines (at five seconds and at thirty), then silence
// until the heartbeat resumes: a stall that lasts two minutes should cost two
// reports, not two hundred.
//
// The blocking frame is named by pausing the main thread through the inspector
// and reading its call frames. The ordering is the whole trick, and it is not
// obvious:
//
//   * The session is opened and `Debugger.enable` is sent AT BOOT, while the
//     loop is still free. An `enable` sent mid-stall never gets a reply — the
//     handshake needs the loop — so arming it late is the same as not arming
//     it at all.
//   * `Debugger.pause`, by contrast, is delivered through a V8 interrupt, so
//     it lands in a spinning thread within a millisecond or two. That is what
//     makes this possible where a SIGUSR2 diagnostic report is not: the report
//     comes through libuv's async queue, so it is written only once the loop
//     yields, and its `javascriptStack` is empty by then.
//
// The pause is never sent to a thread that has come back, and the thread is
// never left paused: the resume is issued on every path out of the pause
// handler, including the one where reading the frames throws.

import fs from 'node:fs';
import { Worker } from 'node:worker_threads';

/** How often the main thread stamps the clock. Short enough that the age of
 *  the stamp is a fair reading of how long the loop has been busy. */
const HEARTBEAT_MS = 500;

/** How often the worker reads the stamp. */
const CHECK_INTERVAL_MS = 1_000;

/** A loop that has not stamped for this long is not slow, it is blocked: the
 *  handlers this process runs are sub-second, and the platform's own health
 *  check gives up not long after. */
const STALL_AFTER_MS = 5_000;

/** How far into one stall each line is written. The first says a stall has
 *  begun; the second, thirty seconds later, says it is the kind that does not
 *  end. Two entries means two lines, ever. */
const REPORT_AT_MS = [5_000, 30_000];

/** How many frames of the paused main thread are worth a line. The frame that
 *  matters is at the top; the rest is express and the module loader. */
const STACK_FRAMES = 30;

/** How long to wait for `Debugger.paused` before saying the pause never
 *  landed. It arrives in a millisecond or two when it arrives at all. */
const PAUSE_WAIT_MS = 2_000;

/** How long the worker is given to drop its inspector session before it is
 *  terminated outright. */
const SHUTDOWN_GRACE_MS = 500;

export interface StallState {
  /** The heartbeat value the stall began from, or null when the loop is
   *  running. */
  blockedFrom: number | null;
  reportsWritten: number;
}

export type StallAction =
  | { kind: 'none' }
  | { kind: 'blocked'; blockedMs: number; reportIndex: number }
  | { kind: 'recovered'; blockedMs: number };

/** The whole decision, as one pure function of the clock and the last stamp.
 *
 *  It is deliberately self-contained — no imports, no module constants, no
 *  closure — because its own source text is what the worker runs (see
 *  `workerSource` below). Anything it reached for outside itself would be
 *  undefined over there. */
function decideStall(input: {
  now: number;
  lastHeartbeat: number;
  state: StallState;
  stallAfterMs: number;
  reportAtMs: number[];
}): { action: StallAction; state: StallState } {
  const { now, lastHeartbeat, state, stallAfterMs, reportAtMs } = input;

  if (now - lastHeartbeat < stallAfterMs) {
    if (state.blockedFrom === null) return { action: { kind: 'none' }, state };
    // The first stamp after a stall closes it: the gap between the last stamp
    // before it and this one is how long the loop was unavailable.
    return {
      action: { kind: 'recovered', blockedMs: lastHeartbeat - state.blockedFrom },
      state: { blockedFrom: null, reportsWritten: 0 },
    };
  }

  const blockedFrom = state.blockedFrom === null ? lastHeartbeat : state.blockedFrom;
  const blockedMs = now - blockedFrom;
  const dueAt = reportAtMs[state.reportsWritten];
  if (dueAt !== undefined && blockedMs >= dueAt) {
    return {
      action: { kind: 'blocked', blockedMs, reportIndex: state.reportsWritten },
      state: { blockedFrom, reportsWritten: state.reportsWritten + 1 },
    };
  }
  return {
    action: { kind: 'none' },
    state: { blockedFrom, reportsWritten: state.reportsWritten },
  };
}

interface WatchdogWorkerData {
  buffer: SharedArrayBuffer;
  checkIntervalMs: number;
  stallAfterMs: number;
  reportAtMs: number[];
  stackFrames: number;
  pauseWaitMs: number;
}

/** One line the worker wrote while the main thread was blocked. The worker
 *  writes it to the standard error descriptor itself — nothing on the main
 *  thread can run to log it — and posts the same text back so that a test (and
 *  anything else on the main thread, once it recovers) can see what was
 *  written. */
export interface WatchdogEvent {
  kind: 'blocked' | 'stack' | 'pause-missed' | 'recovered';
  line: string;
}

/** The worker's body, as source text.
 *
 *  A worker cannot load this module: in development the file is TypeScript and
 *  the worker has no compiler hook, and in the build it is CommonJS under
 *  `build/`, so no single path resolves in both. Handing the worker its source
 *  text sidesteps the resolution problem entirely — and `decideStall.toString()`
 *  means the logic the worker runs is the compiled form of the same function
 *  the unit tests call, rather than a second copy of it that can drift. */
function workerSource(): string {
  return `
const fs = require('node:fs');
const inspector = require('node:inspector');
const { workerData, parentPort } = require('node:worker_threads');

// Bound to a name here rather than relied on to keep its own: what
// \`toString\` yields is a function expression either way.
const decideStall = ${decideStall.toString()};

const opts = workerData;
const heartbeat = new BigInt64Array(opts.buffer);
let state = { blockedFrom: null, reportsWritten: 0 };

function emit(kind, level, message, fields) {
  const line = level + ': ' + message + ' ' + JSON.stringify(fields);
  // Descriptor 2, not process.stderr: the stream is proxied through the main
  // thread, which is the thread that cannot run.
  try {
    fs.writeSync(2, line + '\\n');
  } catch (e) {
    // A closed or full descriptor must not take the watchdog down with it.
  }
  if (parentPort) parentPort.postMessage({ kind, line });
}

// ── The inspector session, opened while the loop can still answer ────────
//
// \`Debugger.enable\` needs a free loop to complete its handshake, so it is sent
// now and never again. \`Debugger.pause\` needs no such thing.

let session = null;
let armed = false;
let pending = null;
// A paused frame carries a script id and, often, an empty url — enabling the
// debugger replays a \`scriptParsed\` for everything already loaded, which is
// where the file names come from.
const scriptUrls = new Map();

function closeSession() {
  if (!session) return;
  const closing = session;
  session = null;
  armed = false;
  try {
    // Without this the process prints "Waiting for the debugger to
    // disconnect..." and hangs on its way out.
    closing.disconnect();
  } catch (e) {
    // Already gone.
  }
}

function formatFrames(callFrames) {
  return callFrames
    .slice(0, opts.stackFrames)
    .map((frame) => {
      const name = frame.functionName || '<anon>';
      // The last two path segments locate the file without printing the whole
      // container path on every frame.
      const url =
        frame.url || (frame.location ? scriptUrls.get(frame.location.scriptId) : '') || '';
      const where = url ? url.split('/').slice(-2).join('/') : '<unknown>';
      const line = frame.location ? frame.location.lineNumber + 1 : 0;
      return name + ' (' + where + ':' + line + ')';
    })
    .join(' <- ');
}

function onPaused(message) {
  const waiting = pending;
  pending = null;
  if (waiting) clearTimeout(waiting.timer);
  try {
    emit('stack', 'error', '[watchdog] main thread stack while blocked', {
      blockedMs: waiting ? waiting.blockedMs : null,
      stack: formatFrames((message.params && message.params.callFrames) || []),
    });
  } catch (e) {
    // Reading the frames must never be the reason a thread stays paused.
  } finally {
    // Every path out of here resumes, including a pause this watchdog did not
    // ask for.
    try {
      if (session) session.post('Debugger.resume', {}, () => {});
    } catch (e) {
      // Nothing left to resume through.
    }
  }
}

function openSession() {
  try {
    const opened = new inspector.Session();
    opened.connectToMainThread();
    opened.on('Debugger.paused', onPaused);
    opened.on('Debugger.scriptParsed', (message) => {
      if (message.params && message.params.url) {
        scriptUrls.set(message.params.scriptId, message.params.url);
      }
    });
    opened.post('Debugger.enable', {}, (err) => {
      if (err) {
        closeSession();
        return;
      }
      armed = true;
    });
    session = opened;
  } catch (e) {
    emit('pause-missed', 'warn', '[watchdog] no inspector session, stacks unavailable', {
      cause: String(e && e.message ? e.message : e),
    });
    session = null;
  }
}

function missed(blockedMs, cause) {
  emit('pause-missed', 'error', '[watchdog] pause did not land', { blockedMs, cause });
}

function requestStack(blockedMs) {
  // One pause in flight at a time, and never one aimed at a thread that has
  // already come back — the stamp is re-read here, as late as it can be.
  if (!armed || !session || pending) return;
  if (Date.now() - Number(Atomics.load(heartbeat, 0)) < opts.stallAfterMs) return;

  const timer = setTimeout(() => {
    if (!pending) return;
    pending = null;
    missed(blockedMs, 'no Debugger.paused within ' + opts.pauseWaitMs + 'ms');
  }, opts.pauseWaitMs);
  pending = { blockedMs, timer };

  try {
    session.post('Debugger.pause', {}, (err) => {
      if (!err || !pending) return;
      clearTimeout(pending.timer);
      pending = null;
      missed(blockedMs, String(err.message || err));
    });
  } catch (e) {
    clearTimeout(timer);
    pending = null;
    missed(blockedMs, String(e && e.message ? e.message : e));
  }
}

openSession();

process.on('exit', closeSession);
if (parentPort) {
  parentPort.on('message', (message) => {
    if (message !== 'shutdown') return;
    closeSession();
    process.exit(0);
  });
}

setInterval(() => {
  const lastHeartbeat = Number(Atomics.load(heartbeat, 0));
  if (lastHeartbeat === 0) return;
  const outcome = decideStall({
    now: Date.now(),
    lastHeartbeat,
    state,
    stallAfterMs: opts.stallAfterMs,
    reportAtMs: opts.reportAtMs,
  });
  state = outcome.state;
  const action = outcome.action;
  if (action.kind === 'blocked') {
    emit('blocked', 'error', '[watchdog] event loop blocked', {
      blockedMs: action.blockedMs,
      rss: process.memoryUsage().rss,
    });
    requestStack(action.blockedMs);
  } else if (action.kind === 'recovered') {
    emit('recovered', 'warn', '[watchdog] event loop recovered', {
      blockedMs: action.blockedMs,
    });
  }
}, opts.checkIntervalMs);
`;
}

export interface WatchdogHandle {
  stop: () => Promise<void>;
}

export interface WatchdogOptions {
  heartbeatMs?: number;
  checkIntervalMs?: number;
  stallAfterMs?: number;
  reportAtMs?: number[];
  stackFrames?: number;
  pauseWaitMs?: number;
  /** Observation hook — the worker's lines arrive here once the loop is free
   *  to run again. Production wires nothing; the tests read it. */
  onEvent?: (event: WatchdogEvent) => void;
}

/** Whether this process should run a watchdog at all. Off by request, and off
 *  under jest, where a worker outliving its suite is a hung run. */
function eventLoopWatchdogEnabled(): boolean {
  if (process.env.EVENT_LOOP_WATCHDOG === '0') return false;
  if (process.env.JEST_WORKER_ID !== undefined) return false;
  return true;
}

function startEventLoopWatchdog(options: WatchdogOptions = {}): WatchdogHandle {
  const buffer = new SharedArrayBuffer(BigInt64Array.BYTES_PER_ELEMENT);
  const heartbeat = new BigInt64Array(buffer);
  const stamp = () => Atomics.store(heartbeat, 0, BigInt(Date.now()));
  stamp();

  const timer = setInterval(stamp, options.heartbeatMs ?? HEARTBEAT_MS);
  // The heartbeat must never be the reason the process stays alive.
  timer.unref();

  const workerData: WatchdogWorkerData = {
    buffer,
    checkIntervalMs: options.checkIntervalMs ?? CHECK_INTERVAL_MS,
    stallAfterMs: options.stallAfterMs ?? STALL_AFTER_MS,
    reportAtMs: options.reportAtMs ?? REPORT_AT_MS,
    stackFrames: options.stackFrames ?? STACK_FRAMES,
    pauseWaitMs: options.pauseWaitMs ?? PAUSE_WAIT_MS,
  };

  const worker = new Worker(workerSource(), { eval: true, workerData });
  worker.unref();
  if (options.onEvent) worker.on('message', options.onEvent);
  worker.on('error', (error) => {
    fs.writeSync(
      2,
      `error: [watchdog] the watchdog thread failed ${JSON.stringify({ cause: error.message })}\n`,
    );
  });

  return {
    stop: async () => {
      clearInterval(timer);
      // Ask first, kill second: the worker holds an inspector session on the
      // main thread, and a process that exits with one still attached prints
      // "Waiting for the debugger to disconnect..." and waits.
      const exited = new Promise<void>((resolve) => {
        worker.once('exit', () => resolve());
      });
      worker.postMessage('shutdown');
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS))]);
      await worker.terminate();
    },
  };
}

/** The boot call: starts a watchdog unless this process has asked not to. */
function startEventLoopWatchdogIfEnabled(): WatchdogHandle | null {
  if (!eventLoopWatchdogEnabled()) return null;
  return startEventLoopWatchdog();
}

export {
  decideStall,
  STACK_FRAMES,
  eventLoopWatchdogEnabled,
  startEventLoopWatchdog,
  startEventLoopWatchdogIfEnabled,
  REPORT_AT_MS,
  STALL_AFTER_MS,
};
