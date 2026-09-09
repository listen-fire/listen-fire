import { currentContext } from '../../../../services/context';
import { trpc } from '../../trpc';
import { userProcedure as sharedUserProcedure } from '../../procedures';
import { companyRouter } from './company';

const portfolioRouter = (procedure: typeof trpc.procedure) => {
  const userProcedure = sharedUserProcedure(procedure);

  return trpc.router({
    company: companyRouter(userProcedure),
  });
};

export { portfolioRouter };
