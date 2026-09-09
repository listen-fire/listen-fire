import OpsDetailLevel from '../../../generated/kysely/automations/OpsDetailLevel';
import OpsSeverity from '../../../generated/kysely/public/OpsSeverity';
import { meetsDetailLevel, shouldPush } from '../types';

describe('meetsDetailLevel', () => {
  it('low team gets only low messages', () => {
    expect(meetsDetailLevel(OpsDetailLevel.low, OpsDetailLevel.low)).toBe(true);
    expect(meetsDetailLevel(OpsDetailLevel.low, OpsDetailLevel.medium)).toBe(false);
    expect(meetsDetailLevel(OpsDetailLevel.low, OpsDetailLevel.full)).toBe(false);
  });
  it('medium team gets low+medium, not full', () => {
    expect(meetsDetailLevel(OpsDetailLevel.medium, OpsDetailLevel.medium)).toBe(true);
    expect(meetsDetailLevel(OpsDetailLevel.medium, OpsDetailLevel.full)).toBe(false);
  });
  it('full team gets everything', () => {
    expect(meetsDetailLevel(OpsDetailLevel.full, OpsDetailLevel.full)).toBe(true);
  });
});

describe('shouldPush', () => {
  it('pushes warn and critical only', () => {
    expect(shouldPush(OpsSeverity.info)).toBe(false);
    expect(shouldPush(OpsSeverity.notable)).toBe(false);
    expect(shouldPush(OpsSeverity.warn)).toBe(true);
    expect(shouldPush(OpsSeverity.critical)).toBe(true);
  });
});
