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

export { requestScopedMap, requestMemo };
