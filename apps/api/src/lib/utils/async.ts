/** Just Promise.all but you don't have to wrap async functions in IIFEs */
function parallel<T extends readonly ((() => unknown) | unknown)[]>(
  threads: [...T],
): Promise<
  [
    ...{
      [k in keyof T]: Awaited<T[k] extends () => infer U ? U : T[k]>;
    },
  ]
> {
  const promises = [threads]
    .flat()
    .map((thread) => (typeof thread === 'function' ? thread() : thread)) as [
    ...{
      [k in keyof T]: T[k] extends () => infer U ? U : T[k];
    },
  ];
  return Promise.all(promises);
}

/** Retry an async function up to N times if it errors */
async function retry<U>(fn: () => Promise<U>, retries: number = 3): Promise<U> {
  try {
    return await fn();
  } catch (e) {
    if (retries > 0) {
      return retry(fn, retries - 1);
    } else {
      throw e;
    }
  }
}

export { parallel, retry };
