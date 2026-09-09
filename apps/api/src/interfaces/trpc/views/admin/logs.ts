import { z } from 'zod';

import { trpc } from '../../trpc';
import { renderLogsUrl } from '../../../../lib/render_logs_url';

const logsRouter = (procedure: typeof trpc.procedure) =>
  trpc.router({
    // Null off Render — the caller opens nothing rather than a dead dashboard.
    getLogsUrl: procedure.input(z.object({ requestId: z.string() })).mutation(async ({ input }) => {
      return renderLogsUrl(input.requestId);
    }),
  });

export { logsRouter };
