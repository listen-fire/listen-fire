import OpsDetailLevel from '../../../generated/kysely/automations/OpsDetailLevel';
import { GLOBAL_DEFAULT_OPS_DETAIL_LEVEL, getTeamDetailLevel } from '../ops_detail';

jest.mock('../../../lib/kysely', () => {
  const exec = jest.fn();
  return {
    getQb: () => ({
      selectFrom: () => ({
        where: () => ({ select: () => ({ executeTakeFirst: exec }) }),
      }),
    }),
    getCoreQb: () => ({
      selectFrom: () => ({
        where: () => ({ select: () => ({ executeTakeFirst: exec }) }),
      }),
    }),
    getAutomationsQb: () => ({
      selectFrom: () => ({
        where: () => ({ select: () => ({ executeTakeFirst: exec }) }),
      }),
    }),
    __exec: exec,
  };
});

const { __exec } = jest.requireMock('../../../lib/kysely') as { __exec: jest.Mock };

describe('getTeamDetailLevel', () => {
  it('returns the global default for a null team', async () => {
    expect(await getTeamDetailLevel(null)).toBe(GLOBAL_DEFAULT_OPS_DETAIL_LEVEL);
  });
  it('returns the global default when the row is missing', async () => {
    __exec.mockResolvedValueOnce(undefined);
    expect(await getTeamDetailLevel('team_x')).toBe(GLOBAL_DEFAULT_OPS_DETAIL_LEVEL);
  });
  it('returns the stored level', async () => {
    __exec.mockResolvedValueOnce({ ops_detail_level: OpsDetailLevel.full });
    expect(await getTeamDetailLevel('team_x')).toBe(OpsDetailLevel.full);
  });
});
