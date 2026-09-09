const withResolvers = () => {
  const out = {} as { promise: Promise<void>; resolve: () => void; reject: () => void };

  out.promise = new Promise<void>((resolve, reject) => {
    out.resolve = resolve;
    out.reject = reject;
  });

  return out;
};

function getTimeout() {
  let interrupt = () => {};
  return {
    next: async (ms: number) => {
      interrupt();
      const p = withResolvers();
      let isResolved = false;
      const resolve = () => {
        if (isResolved) return;
        isResolved = true;
        p.resolve();
      };

      const t = setTimeout(resolve, ms);
      t.unref();

      interrupt = () => {
        clearTimeout(t);
        resolve();
      };

      await p.promise;
    },
    interrupt: () => {
      interrupt();
    },
  };
}

async function setJitteredTimeout({
  baseMs,
  jitterMs = 0,
}: {
  baseMs: number;
  /** (min + jitter) will be the maximum wait time. (Math.random() * jitter) will be added to each timeout  */
  jitterMs?: number;
}): Promise<void> {
  const waitMs = baseMs + jitterMs * Math.random();
  await new Promise((res) => setTimeout(res, waitMs));
}

export { getTimeout, setJitteredTimeout };
