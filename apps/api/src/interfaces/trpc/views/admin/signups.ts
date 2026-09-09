// Admin signups feed — recent account creations with their acquisition channel
// (auth method) + marketing attribution (utm_* + referrer), for the admin app.

import { z } from 'zod';

import { trpc } from '../../trpc';
import { getQb } from '../../../../lib/kysely';

const signupsRouter = (procedure: typeof trpc.procedure) => {
  return trpc.router({
    list: procedure
      .input(z.object({ limit: z.number().min(1).max(500).optional() }).optional())
      .query(async ({ input }) => {
        const rows = await getQb(['signup_event'])
          .selectFrom('signup_event')
          .select([
            'id',
            'email',
            'team_id',
            'channel',
            'utm_source',
            'utm_medium',
            'utm_campaign',
            'utm_term',
            'utm_content',
            'referrer',
            'created_at',
          ])
          .orderBy('created_at', 'desc')
          .limit(input?.limit ?? 200)
          .execute();
        return { rows };
      }),
  });
};

export { signupsRouter };
