import { Context, unsafeCurrentContext } from '../../services/context';

/**
 * Per-request memo stores for the lookups the valuation walk asks for over and
 * over — an exchange rate, an asset's latest price, what an asset tracks.
 *
 * A portfolio list values every company separately (the walk is not a pure
 * function of its seed set, so it stays one walk per row), and each of those
 * walks re-asks the same handful of graph facts. The facts themselves are pure
 * functions of the database, so within one request the second ask can be the
 * first ask's answer.
 *
 * Scope is the running `Context`: one request, one team, one set of answers,
 * released with the request. Nothing survives into the next one, so a write in
 * a later request always sees fresh data. The one thing this does NOT survive
 * is a request that writes a price (or an issuer's underlying company) and then
 * re-reads it — reads and writes live in separate procedures today, so no path
 * does.
 *
 * Outside a request (a unit test calling the lookup directly) there is no
 * context to hang a store on and every call goes to the database, exactly as
 * it did before.
 */
function requestScopedMap<V>(): () => Map<string, V> {
  const byContext = new WeakMap<Context, Map<string, V>>();

  return () => {
    const ctx = unsafeCurrentContext();
    if (!ctx) return new Map();

    const existing = byContext.get(ctx);
    if (existing) return existing;

    const store = new Map<string, V>();
    byContext.set(ctx, store);
    return store;
  };
}

/**
 * Memoises a single-answer lookup for the life of the request. `identity` must
 * name everything that changes the answer.
 */
function requestMemo<A, V>({
  identity,
  compute,
}: {
  identity: (argument: A) => string;
  compute: (argument: A) => Promise<V>;
}): (argument: A) => Promise<V> {
  const store = requestScopedMap<Promise<V>>();

  return (argument) => {
    const cache = store();
    const key = identity(argument);
    const cached = cache.get(key);
    if (cached) return cached;

    const pending = compute(argument);
    // A rejection is the request's answer too, and every caller of it awaits
    // the same promise — but the copy sitting in the cache is unobserved, and
    // an unobserved rejection takes the process down.
    pending.catch(() => {});
    cache.set(key, pending);
    return pending;
  };
}

/**
 * A lookup that answers one key at a time but asks the database in batches.
 *
 * The portfolio list values every company separately, so the same handful of
 * lookups — what an asset's transactions are, what it is priced at — are asked
 * once per row. Each ask is cheap to execute and expensive to plan, and six
 * hundred of them is six hundred round trips. Every ask made before the current
 * batch flushes joins it instead: the callers still write a single-key lookup,
 * and the database sees one query per level of the walk rather than one per
 * company.
 *
 * The batch closes at the end of the current microtask drain, which is when the
 * row valuations running under one `Promise.all` have all taken their next step.
 * A key already asked for in this request is answered from the batch it was in,
 * exactly as `requestMemo` would.
 *
 * Outside a request there is no context to hang a batch on, so every call
 * flushes on its own — correct, just uncoalesced.
 */
function requestBatchLoader<A, V>({
  identity,
  fetch,
}: {
  identity: (argument: A) => string;
  /** Answers a whole batch, keyed by `identity`. A key the fetch has no answer
   *  for is simply absent from the map, and its caller gets `undefined`. */
  fetch: (batch: A[]) => Promise<Map<string, V>>;
}): (argument: A) => Promise<V | undefined> {
  type Scope = {
    /** The batch still taking callers, if one is. */
    open?: { queue: A[]; result: Promise<Map<string, V>> };
    /** Every key this request has ever asked for, and its answer. */
    answers: Map<string, Promise<V | undefined>>;
  };
  const scopeStore = requestScopedMap<Scope>();

  return (argument) => {
    const store = scopeStore();
    let scope = store.get('scope');
    if (!scope) {
      scope = { answers: new Map() };
      store.set('scope', scope);
    }
    const current = scope;

    const key = identity(argument);
    const answered = current.answers.get(key);
    if (answered) return answered;

    if (!current.open) {
      const queue: A[] = [];
      const result = new Promise<Map<string, V>>((resolve, reject) => {
        queueMicrotask(() => {
          current.open = undefined;
          fetch(queue).then(resolve, reject);
        });
      });
      // Every caller awaits its own read of this promise; the copy held here is
      // unobserved, and an unobserved rejection takes the process down.
      result.catch(() => {});
      current.open = { queue, result };
    }

    current.open.queue.push(argument);
    const answer = current.open.result.then((answers) => answers.get(key));
    answer.catch(() => {});
    current.answers.set(key, answer);
    return answer;
  };
}

export { requestScopedMap, requestMemo, requestBatchLoader };
