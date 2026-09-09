import { trpc } from '../../trpc';
import { platformAdminProcedure } from '../../procedures';
import { legalEntityManagerRouter } from './legalEntityManager';
import { authenticateAsRouter } from './authenticateAs';
import { logsRouter } from './logs';
import { userManagementRouter } from './userManagement';
import { llmUsageRouter } from './llmUsage';
import { usageConfigRouter } from './usageConfig';
import { crossTeamOpsRouter } from './crossTeamOps';
import { signupsRouter } from './signups';

const adminRouter = (procedure: typeof trpc.procedure) => {
  const adminProcedure = platformAdminProcedure(procedure);

  return trpc.router({
    legalEntityManager: legalEntityManagerRouter(adminProcedure),
    authenticateAs: authenticateAsRouter(adminProcedure),
    logs: logsRouter(adminProcedure),
    userManagement: userManagementRouter(adminProcedure),
    llmUsage: llmUsageRouter(adminProcedure),
    usageConfig: usageConfigRouter(adminProcedure),
    crossTeamOps: crossTeamOpsRouter(adminProcedure),
    signups: signupsRouter(adminProcedure),
  });
};

export { adminRouter };
