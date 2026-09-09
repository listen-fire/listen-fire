// A per-key single-flight slot (asks-as-adapter chunk C, F18/F21). At most ONE
// task per key runs at a time; everything else for that key queues behind it.
//
// The slot has TWO entry points because its callers hand it two DIFFERENT kinds
// of task, and conflating them is a double-execution bug:
//
//   • `coalesce` — the task RE-GATHERS everything currently outstanding for the
//     key (the await drain). Such a task is safe to skip and safe to replay, so
//     a burst of arrivals mid-flight collapses onto EXACTLY ONE follow-up pass
//     that picks up whatever became resolvable meanwhile. This is what makes the
//     resume scan deterministic under concurrent nudges: two near-simultaneous
//     answers to two asks of the SAME run become one batch scan (one multi-winner
//     tie) rather than two overlapping scans settling the same race frame.
//
//   • `exclusive` — this EXACT task runs EXACTLY ONCE, serialized behind whoever
//     holds the key. A callback body is one of these: it belongs to one recorded
//     call, it is not re-gatherable, and replaying it applies its writes twice.
//
// A coalescing task is therefore never a substitute for an exclusive one and
// vice versa; the entry point a caller picks IS the claim it is making about its
// task.

export interface SingleFlight<K> {
  /** Replayable, skippable: the task re-gathers all outstanding work for the key. */
  coalesce(key: K, task: () => Promise<void>): Promise<void>;
  /** One-shot: this task runs exactly once, never coalesced, never replayed. */
  exclusive(key: K, task: () => Promise<void>): Promise<void>;
}

interface Slot {
  /** The chain every new entry appends to — `null` while the key is idle, so the
   *  first entry starts SYNCHRONOUSLY (a caller that enqueues and immediately
   *  inspects sees the task already under way). */
  tail: Promise<void> | null;
  /** A coalescing pass that is QUEUED but has not started: further coalescing
   *  arrivals join it instead of queueing another. Cleared the moment it starts,
   *  so an arrival DURING a pass queues a fresh follow-up rather than being lost. */
  queuedCoalesce: Promise<void> | null;
}

const swallow = (): undefined => undefined;

/** Call now, turning a synchronous throw into a rejection — preserves the
 *  start-on-enqueue behaviour a plain `.then` would defer. */
function invoke(task: () => Promise<void>): Promise<void> {
  try {
    return task();
  } catch (err) {
    return Promise.reject(err);
  }
}

export function createSingleFlight<K>(): SingleFlight<K> {
  const slots = new Map<K, Slot>();

  function enqueue(key: K, task: () => Promise<void>, coalescing: boolean): Promise<void> {
    let slot = slots.get(key);
    if (slot === undefined) {
      slot = { tail: null, queuedCoalesce: null };
      slots.set(key, slot);
    } else if (coalescing && slot.queuedCoalesce !== null) {
      return slot.queuedCoalesce;
    }
    const current = slot;
    const previous = current.tail;

    const start = (): Promise<void> => {
      // This pass is no longer the QUEUED one — an arrival from here on queues a
      // fresh follow-up.
      if (coalescing) current.queuedCoalesce = null;
      return invoke(task);
    };
    const ran = previous === null ? start() : previous.then(start);

    // The chain must survive a failing task (a rejection reaches the caller's own
    // promise, never the next entry's turn).
    const chained = ran.then(swallow, swallow);
    current.tail = chained;
    void chained.then(() => {
      // Nothing queued behind us: the key is idle again and can be forgotten.
      if (current.tail === chained && slots.get(key) === current) slots.delete(key);
    });

    if (coalescing && previous !== null) current.queuedCoalesce = ran;
    return ran;
  }

  return {
    coalesce: (key, task) => enqueue(key, task, true),
    exclusive: (key, task) => enqueue(key, task, false),
  };
}
