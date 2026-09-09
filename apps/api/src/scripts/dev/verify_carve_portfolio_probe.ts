/**
 * Throwaway Phase 5.1 probe: does the API or the ported UI produce the zeros?
 * Calls getOverview + getPortfolioInvestments through the real tRPC caller and
 * getInvestmentsValuation directly, against the seeded NewCo investment.
 */
import { runInContext } from '../../services/context/utils';
import { getCoreQb, getValuationsQb } from '../../lib/kysely';
import { trpcRouter } from '../../interfaces/trpc';
import { getInvestmentsValuation } from '../../lib/valuations/valuation';
import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';

const SLUG = 'newco-carve-probe';

async function main() {
  const user = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['id', 'default_team_id'])
    .where('username', '=', 'dev-loop')
    .executeTakeFirstOrThrow();

  const investment = await getValuationsQb(['investment', 'legal_entity'])
    .selectFrom('investment as i')
    .innerJoin('legal_entity as le', 'le.id', 'i.investment_profile_id')
    .select(['i.id', 'i.invested_at'])
    .where('le.slug', '=', SLUG)
    .executeTakeFirstOrThrow();

  await runInContext(
    async (ctx) => {
      await ctx.enterTransaction();
      const caller = trpcRouter.createCaller({ authorise: async () => {} });
      const out: Record<string, unknown> = {};

      const overview = await caller.views.portfolio.company.getOverview({
        slug: SLUG,
        config: { currency: 'GBP' },
      });
      out.getOverview = overview && {
        id: overview.id,
        name: overview.name,
        investments: overview.investments,
        investmentsIsNull: overview.investments === null,
        investingEntities: overview.investingEntities,
        invested: overview.invested,
        value: overview.value,
        realizedValue: overview.realizedValue,
        totalShares: overview.totalShares,
        moic: overview.moic,
        holdingsLength: overview.holdings?.length,
      };

      const list = await caller.views.investments.getPortfolioInvestments({
        limit: 50,
        filter: {},
        config: { currency: 'GBP', aggregation: 'company' },
      } as never);
      out.getPortfolioInvestments_rawKeys = Array.isArray(list) ? 'array' : Object.keys(list ?? {});
      out.getPortfolioInvestments = JSON.parse(JSON.stringify(list));

      out.getInvestmentsValuation_direct = await getInvestmentsValuation({
        investments: [{ id: investment.id, date: investment.invested_at }],
        targetCurrency: CurrencyIsoCode.GBP,
        asOfDate: new Date(),
        fxDate: new Date(),
      });

      console.log(JSON.stringify(out, null, 2));
    },
    { id: user.id },
  );
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
