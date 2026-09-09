import EventEmitter from 'node:events';

import { MQ } from '../native';

type MockFnWithListener = ((...args: unknown[]) => unknown) & {
  listener: EventEmitter;
  calls: number;
  args?: unknown[];
};

const mockFnWithListener = (fn: (...args: unknown[]) => unknown): MockFnWithListener => {
  const mocked = ((...args: unknown[]) => {
    mocked.args = args;
    mocked.calls++;
    mocked.listener.emit('called', args);
    return fn(...args);
  }) as MockFnWithListener;

  mocked.listener = new EventEmitter();
  mocked.calls = 0;
  return mocked;
};

const expectToBeCalledWithin = (fn: MockFnWithListener, timeout: number) => {
  if (fn.calls > 0) {
    return expect(new Promise((resolve) => resolve(fn.args))).resolves;
  }

  const promise = new Promise((resolve, reject) => {
    let done = false;

    const timeoutId = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`Expected ${fn.name} to be called within ${timeout}ms`));
    }, timeout);

    fn.listener.on('called', (args) => {
      if (done) return;
      done = true;
      clearTimeout(timeoutId);
      resolve(args);
    });
  });

  return expect(promise).resolves;
};

describe('MQ (message queue)', () => {
  const mq = new MQ<{ id: string; name: string }>();

  const testMessage = { id: 'test-id', name: 'Joe Bloggs' };
  it('forwards messages from a fanout exchange', async () => {
    mq.deleteAll();
    const exchange = mq.node({
      name: 'allNames',
      type: 'fanout',
    });
    const queue = mq.node({ name: 'nameQueue', type: 'queue' });
    queue.attachTo(exchange);

    const listener = mockFnWithListener(() => {});
    queue.on('message', listener);
    exchange.publish(testMessage).catch(console.error);

    await expectToBeCalledWithin(listener, 100).toEqual([testMessage]);
  });

  it('forwards messages from a direct exchange', async () => {
    mq.deleteAll();
    const exchange = mq.node({
      name: 'allNames',
      type: 'direct',
      key: 'id',
      keyPrefix: 'id.',
    });
    const queue = mq.node({
      name: 'id.test-id',
      type: 'queue',
    });
    queue.attachTo(exchange);
    const queue2 = mq.node({
      name: 'id.other-id',
      type: 'queue',
    });
    queue2.attachTo(exchange);

    const listener = mockFnWithListener(() => {});
    queue.on('message', listener);
    const listener2 = mockFnWithListener(() => {});
    queue2.on('message', listener2);
    exchange.publish(testMessage).catch(console.error);

    await expectToBeCalledWithin(listener, 1000).toEqual([testMessage]);
    expect(listener2.calls).toEqual(0);
  });

  it('forwards messages from a fanout exchange to a direct exchange', async () => {
    mq.deleteAll();
    const fanoutExchange = mq.node({
      name: 'allNames',
      type: 'fanout',
    });
    const directExchange = mq.node({
      name: 'idRouter',
      type: 'direct',
      key: 'id',
      keyPrefix: 'feed.id.',
    });
    directExchange.attachTo(fanoutExchange);
    const queue = mq.node({
      name: 'feed.id.test-id',
      type: 'queue',
    });
    queue.attachTo(directExchange);
    const queue2 = mq.node({
      name: 'feed.id.other-id',
      type: 'queue',
    });
    queue2.attachTo(directExchange);

    const listener = mockFnWithListener(() => {});
    queue.on('message', listener);
    const listener2 = mockFnWithListener(() => {});
    queue2.on('message', listener2);
    fanoutExchange.publish(testMessage).catch(console.error);

    await expectToBeCalledWithin(listener, 100).toEqual([testMessage]);
    expect(listener2.calls).toEqual(0);
  });

  it('respects the match function on a fanout exchange', async () => {
    mq.deleteAll();
    const topLevelExchange = mq.node({
      name: 'allNames',
      type: 'fanout',
    });
    const exchange1 = mq.node({
      name: 'joe',
      match: async (message) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return message.name === 'Joe Bloggs';
      },
      type: 'fanout',
    });
    const exchange2 = mq.node({
      name: 'john',
      match: async (message) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return message.name === 'John Doe';
      },
      type: 'fanout',
    });
    exchange1.attachTo(topLevelExchange);
    exchange2.attachTo(topLevelExchange);

    const queue = mq.node({ name: '1queue', type: 'queue' });
    queue.attachTo(exchange1);
    const queue2 = mq.node({ name: '2queue', type: 'queue' });
    queue.attachTo(exchange2);

    const listener = mockFnWithListener(() => {});
    queue.on('message', listener);
    const listener2 = mockFnWithListener(() => {});
    queue2.on('message', listener2);
    topLevelExchange.publish(testMessage).catch(console.error);

    await expectToBeCalledWithin(listener, 100).toEqual([testMessage]);
    expect(listener2.calls).toEqual(0);
  });
});
