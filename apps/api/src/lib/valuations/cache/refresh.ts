import { getQb, getValuationsQb } from '../../kysely';
import { currentContext } from '../../../services/context';
import { TeamId } from '../../../generated/kysely/core/Team';
import { warmInventoryCacheForInvestment } from './write';

interface RefreshResult {
  warmed: number;
  failed: { investmentId: string; error: string }[];
}

async function refreshInventoryCache({
  investmentIds,
  concurrency = 5,
  asOfDate,
  strategy = 'FIFO',
  onProgress,
}: {
  investmentIds?: string[];
  concurrency?: number;
  asOfDate?: Date;
  strategy?: 'LIFO' | 'FIFO';
  onProgress?: (done: number, total: number, currentId: string) => void;
} = {}): Promise<RefreshResult> {
  const teamId = currentContext().user.teamId;
  const ids = investmentIds ?? (await listAllInvestmentIdsForTeam(teamId));

  const result: RefreshResult = { warmed: 0, failed: [] };
  let cursor = 0;

  async function worker() {
    while (cursor < ids.length) {
      const idx = cursor++;
      const id = ids[idx];
      try {
        await warmInventoryCacheForInvestment({ investmentId: id, asOfDate, strategy });
        result.warmed += 1;
      } catch (err) {
        result.failed.push({
          investmentId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      onProgress?.(idx + 1, ids.length, id);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, () => worker()));

  return result;
}

async function listAllInvestmentIdsForTeam(teamId: string): Promise<string[]> {
  const rows = await getValuationsQb(['investment'])
    .selectFrom('investment')
    .select('id')
    .where('team_id', '=', teamId as TeamId)
    .execute();
  return rows.map((r) => r.id);
}

export { refreshInventoryCache, RefreshResult };
