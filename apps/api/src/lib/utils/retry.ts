const noopCatch = () => undefined;

type PromiseWithCancel<T> = Promise<T> & { cancel: () => void };
type TimeoutState = 'timed_out' | 'cancelled';

// create a promise that resolves after a given interval
function getTimerPromise(interval: number): PromiseWithCancel<TimeoutState> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cleanup: (() => void) | undefined;

  const promise = new Promise<TimeoutState>((resolve) => {
    timer = setTimeout(() => {
      cleanup = undefined;
      resolve('timed_out');
    }, interval);

    cleanup = () => {
      clearInterval(timer);
      resolve('cancelled');
    };
  }) as PromiseWithCancel<TimeoutState>;
  promise.cancel = () => cleanup?.();

  return promise;
}

function getIsTimedOut(promise: PromiseWithCancel<TimeoutState>): () => boolean {
  let timedOut = false;
  promise.then((state) => {
    timedOut = state === 'timed_out' ? true : timedOut;
  }, noopCatch);

  return () => timedOut;
}

function getIsResolved<T>(promise: Promise<T>): () => boolean {
  let resolved = false;
  promise.then(() => {
    resolved = true;
  }, noopCatch);

  return () => resolved;
}

const retryUntilResolves = async <T>({
  action,
  target,
  interval,
  timeout,
}: {
  // some repeatable action that should make progress towards the target
  action: (iteration: number) => unknown;
  // the target promise that should eventually resolve
  target: Promise<T>;
  // the retry interval
  interval: number;
  // the timeout for the entire operation
  timeout: number;
}): Promise<T> => {
  const timeoutPromise = getTimerPromise(timeout);

  const isFinished = getIsResolved(target);
  const isTimedOut = getIsTimedOut(timeoutPromise);

  // ensure that if the target or timeout have already resolved, we don't try the action
  await getTimerPromise(0);

  let iteration = 0;
  while (!isFinished() && !isTimedOut()) {
    const retryPromise = getTimerPromise(interval);

    await action(iteration);
    await Promise.race([target, retryPromise, timeoutPromise]);

    // clean up retry
    retryPromise.cancel();

    iteration++;
  }

  // clean up timeout
  timeoutPromise.cancel();
  if (!isFinished()) {
    throw new Error('Timed out');
  }

  return target;
};

export { retryUntilResolves };
