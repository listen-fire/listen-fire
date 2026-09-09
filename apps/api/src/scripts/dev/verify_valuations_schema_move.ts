/**
 * Phase 2D verification: the portfolio tRPC surface after the valuations
 * family moved schemas. Exercises the procedures whose queries cross the new
 * boundary — the holdings list (`investments.getBaseQuery`, which joins
 * `valuations.*` to `public.user`), the company page's overview and funding
 * changelog, and the investing-entity typeahead (which now reads
 * `valuations.team_settings` instead of joining core's `team`).
 */
import { runInContext } from '../../services/context/utils';
import { getCoreQb, getValuationsQb } from '../../lib/kysely';
import { trpcRouter } from '../../interfaces/trpc';

async function main() {
  const team = await getCoreQb(['team']).selectFrom('team').select('id').executeTakeFirstOrThrow();
  const user = await getCoreQb(['user'])
    .selectFrom('user')
    .select('id')
    .executeTakeFirstOrThrow();

  const company = await getValuationsQb(['legal_entity'])
    .selectFrom('legal_entity')
    .select(['id', 'slug', 'name'])
    .where('team_id', '=', team.id)
    .where('is_portfolio', '=', true)
    .executeTakeFirst();

  await runInContext(
    async (ctx) => {
      await ctx.enterTransaction();
      const caller = trpcRouter.createCaller({ authorise: async () => {} });
      const out: Record<string, unknown> = {};

      const args = { filter: {}, config: {} } as never;
      const list = await caller.views.investments.getPortfolioInvestments(args);
      out.holdingsList = Array.isArray(list) ? list.length : Object.keys(list ?? {});

      out.totals = !!(await caller.views.investments.getPortfolioTotals(args));

      out.investingEntityTypeahead = (
        await caller.views.portfolio.company.findInvestingEntitiesByName({ name: '' })
      ).length;

      if (company) {
        out.changelog = (
          await caller.views.portfolio.company.getFundingChangelog({ legalEntityId: company.id })
        ).length;
        out.companyOverview = company.slug
          ? { slug: company.slug, got: !!(await caller.views.portfolio.company.getOverview({ slug: company.slug })) }
          : `skipped — seeded company "${company.name}" has no slug (known dev-fixture defect)`;
      }

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
