import { Context, currentContext } from '../services/context';

/**
 * A simple cache that stores values in the current context.
 */
class Cache<Key, Value> {
  private _cache = new WeakMap<Context, Map<string, Value>>();

  constructor(private getCacheKey: (key: Key) => string) {}

  addToCache(key: Key, value: Value) {
    const ctx = currentContext();

    if (!this._cache.has(ctx)) {
      this._cache.set(ctx, new Map());
    }

    const cache = this._cache.get(ctx)!;
    cache.set(this.getCacheKey(key), value);
  }

  getFromCache(key: Key) {
    const ctx = currentContext();

    if (!this._cache.has(ctx)) {
      return;
    }

    const cache = this._cache.get(ctx)!;
    return cache.get(this.getCacheKey(key));
  }

  clearCache() {
    this._cache.delete(currentContext());
  }

  clearCacheFor(key: Key) {
    const ctx = currentContext();
    if (this._cache.has(ctx)) {
      this._cache.get(ctx)!.delete(this.getCacheKey(key));
    }
  }
}

/**
 * Wraps a function with a cache that stores the result of the function in the current context.
 *
 * @param getKey A function that returns a unique key for the cache entry based on the input to the function.
 * @param fn The function to cache.
 */
function withCache<Fn extends (key: any) => Promise<any>>( // eslint-disable-line @typescript-eslint/no-explicit-any
  getKey: (key: Parameters<Fn>[0]) => string,
  fn: Fn,
): Fn {
  const cache = new Cache<Parameters<Fn>[0], Awaited<ReturnType<Fn>>>(getKey);
  return (async (key: Parameters<Fn>[0]) => {
    const cachedValue = cache.getFromCache(key);
    if (cachedValue) {
      return cachedValue;
    }

    const value = (await fn(key)) as Awaited<ReturnType<Fn>>;
    cache.addToCache(key, value);
    return value;
  }) as Fn;
}

export { withCache };
