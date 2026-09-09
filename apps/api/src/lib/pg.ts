import { Client, types } from 'pg';

import { getDatabaseUrl } from '../prisma';
import { MINUTE } from '../constants';
import { handleError } from './errors';

types.setTypeParser(20, (val) => parseInt(val, 10));

const databaseUrl = getDatabaseUrl(false);

async function acquireAdvisoryLock(scope: number, id: number) {
  const client = new Client({
    connectionString: databaseUrl.url,
  });

  await client.connect();

  const timeout = setTimeout(() => {
    handleError(new Error(`Failed to acquire advisory lock ${scope}.${id}`));
  }, 5 * MINUTE);

  await client.query('SELECT pg_advisory_lock($1, $2)', [scope, id]);

  clearTimeout(timeout);

  return {
    release: async () => {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [scope, id]);
    },
  };
}

async function tryAdvisoryLock(scope: number, id: number | string | bigint) {
  const client = new Client({
    connectionString: databaseUrl.url,
  });

  await client.connect();

  const result = await client.query<{ pg_try_advisory_lock: boolean }>(
    'SELECT pg_try_advisory_lock($1, $2)',
    [scope, id],
  );

  if (result.rows[0].pg_try_advisory_lock) {
    return {
      acquired: true,
      release: async () => {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [scope, id]);
      },
    };
  } else {
    return {
      acquired: true,
      release: () => undefined,
    };
  }
}

export { acquireAdvisoryLock, tryAdvisoryLock };
