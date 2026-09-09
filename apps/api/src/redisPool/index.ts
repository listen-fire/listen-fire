import IORedis, { Redis } from 'ioredis';
import { createPool, Pool } from 'generic-pool';

import { getEnvVar } from '../lib/utils/environment';

let redisPool: Pool<Redis> | null = null;

function getRedisPool(): Pool<Redis> {
  if (!redisPool) {
    const factory = {
      create: async () => {
        const host = getEnvVar('MESSAGE_QUEUE_REDIS_HOSTNAME', { devDefault: 'localhost' });
        const port = getEnvVar('MESSAGE_QUEUE_REDIS_PORT', {
          devDefault: '6379',
        });
        const client = new IORedis(Number(port), host, {
          maxRetriesPerRequest: null,
        });
        await client.ping();
        return client;
      },

      destroy: async (client: Redis) => {
        await client.quit();
      },
    };

    redisPool = createPool<Redis>(factory, {
      max: 150, // The max on our render server is 250 so this should be fine.
      min: 2,
    });
  }

  return redisPool;
}

export { getRedisPool };
