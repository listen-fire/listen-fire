// Guards two things about the loop primitive that only show up in the
// aggregate: the process installs ONE shutdown handler pair no matter how many
// loops run (thirteen pairs blew past Node's default MaxListeners cap and put
// a warning in every boot log), and a named worker publishes a tick the health
// surface can read.
import { runNamedWorker, worker, workerTick } from '../worker';

/** Let the loop finish its first iteration without waiting out an interval. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

const FOREVER = 60_000;

describe('worker — shutdown handlers', () => {
  it('adds one SIGINT/SIGTERM pair for the whole process, not one per loop', async () => {
    const before = {
      int: process.listenerCount('SIGINT'),
      term: process.listenerCount('SIGTERM'),
    };

    for (let i = 0; i < 5; i++) worker(() => {}, FOREVER);
    await settle();

    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
  });
});

describe('runNamedWorker', () => {
  it('publishes a tick under the registry\'s id once an iteration completes', async () => {
    runNamedWorker('test.ticks', () => worker(() => {}, FOREVER));

    await settle();
    await settle();

    const tick = workerTick('test.ticks');
    expect(tick?.failing).toBe(false);
    expect(tick?.lastTickAt).toBeInstanceOf(Date);
  });

  it('records a failing iteration rather than swallowing it', async () => {
    runNamedWorker('test.throws', () =>
      worker(() => {
        throw new Error('nope');
      }, FOREVER),
    );

    await settle();
    await settle();

    expect(workerTick('test.throws')?.failing).toBe(true);
  });

  it('fails the boot when one registered worker starts two loops', () => {
    expect(() =>
      runNamedWorker('test.two', () => {
        worker(() => {}, FOREVER);
        worker(() => {}, FOREVER);
      }),
    ).toThrow(/starts more than one loop/);
  });

  it('leaves an unregistered loop anonymous rather than inventing a name', async () => {
    worker(() => {}, FOREVER);
    await settle();

    expect(workerTick('')).toBeUndefined();
  });
});
