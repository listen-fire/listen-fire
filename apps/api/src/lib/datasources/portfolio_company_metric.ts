import * as db from '@prisma/client';
import Dataloader, { Options } from 'dataloader';

import { hash } from '../utils/hash';

type PortfolioCompanyMetricByCompanyAndInvestorIdDataLoader = Dataloader<
  CompanyAndInvestorIdKey,
  db.PortfolioCompanyMetric | null
>;

type CompanyAndInvestorIdKey = {
  investorId: string;
  companyId: string;
};

function getPortfolioCompanyMetricByCompanyAndInvestorIdDataloader(
  prisma: db.Prisma.TransactionClient,
  dataloaderOptions?: Options<CompanyAndInvestorIdKey, db.PortfolioCompanyMetric | null, string>,
): PortfolioCompanyMetricByCompanyAndInvestorIdDataLoader {
  return new Dataloader(async (keys) => {
    // Prisma does not support filtering by a list of tuples
    // see https://github.com/prisma/prisma/issues/10241
    const joinedTuples = keys
      .map(({ investorId, companyId }) => `('${investorId}','${companyId}')`)
      .join();

    const metrics = await prisma.$queryRawUnsafe<db.PortfolioCompanyMetric[]>(`
      SELECT *
      FROM portfolio_company_metric
      WHERE (investor_id, company_id) IN (${joinedTuples})`);

    const metricsByKey = new Map(
      metrics.map((item) => [
        hash<CompanyAndInvestorIdKey>({
          investorId: item.investorId,
          companyId: item.companyId,
        }),
        item,
      ]),
    );
    return keys.map((key) => metricsByKey.get(hash<CompanyAndInvestorIdKey>(key)) ?? null);
  }, dataloaderOptions);
}

export { getPortfolioCompanyMetricByCompanyAndInvestorIdDataloader };
