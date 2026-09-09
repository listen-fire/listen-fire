/**
 * Phase 5.3 verification: investments.getCSVExport should emit
 * `${WEB_BASE_URL}/portfolio/c/<slug>` in the "Link" column, not a
 * bare `/c/<slug>` (the deleted public profile route).
 */
import { runInContext } from '../../services/context/utils';
import { getCoreQb } from '../../lib/kysely';
import { trpcRouter } from '../../interfaces/trpc';

async function main() {
  const user = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['id', 'default_team_id'])
    .where('username', '=', 'dev-loop')
    .executeTakeFirstOrThrow();

  await runInContext(
    async (ctx) => {
      await ctx.enterTransaction();
      const caller = trpcRouter.createCaller({ authorise: async () => {} });

      const rows = await caller.views.investments.getCSVExport({
        filter: {},
        config: { aggregation: 'company' },
        grouping: 'investment_date',
      } as never);

      const rowsArr = rows as Array<Record<string, unknown>>;
      console.log(`rows=${rowsArr.length}`);
      const withLink = rowsArr.filter((r) => typeof r['Link'] === 'string');
      console.log(`rows with Link=${withLink.length}`);
      for (const r of withLink) {
        console.log(JSON.stringify({ Name: r.Name, 'Link': r['Link'] }));
      }

      const failures = withLink.filter((r) => {
        const link = r['Link'] as string;
        return !link.includes('/portfolio/c/') || /https?:\/\/[^/]+\/c\//.test(link);
      });

      console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}  all Link values contain /portfolio/c/ and no bare /c/`);
      if (failures.length) {
        console.log('offending rows:', JSON.stringify(failures, null, 2));
        throw new Error(`${failures.length} row(s) had a bad Link`);
      }
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
