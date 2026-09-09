// `sweepExpiredFiles` — deletes expired exposures' S3 objects then their rows.
// An S3 delete failure leaves the row for the next sweep. getQb + the S3
// provider are mocked.

interface ExpiredRow {
  id: string;
  object_uri: string;
}
let expiredRows: ExpiredRow[] = [];
const deletedRowIds: string[] = [];

jest.mock('../../../lib/kysely', () => ({
  getAutomationsQb: () => ({
    selectFrom: () => ({
      select: () => ({
        where: () => ({
          limit: () => ({ execute: async () => expiredRows }),
        }),
      }),
    }),
    deleteFrom: () => ({
      where: (_col: string, _op: string, id: string) => ({
        execute: async () => {
          deletedRowIds.push(id);
        },
      }),
    }),
  }),
}));

const deleteMock = jest.fn(async (_uri: string) => {});
jest.mock('../../../adapters/registry', () => ({
  services: { document: { delete: deleteMock } },
}));

import { sweepExpiredFiles } from '../worker';

describe('sweepExpiredFiles', () => {
  beforeEach(() => {
    expiredRows = [];
    deletedRowIds.length = 0;
    deleteMock.mockReset();
    deleteMock.mockResolvedValue(undefined);
  });

  it('deletes each expired exposure: S3 object then row', async () => {
    expiredRows = [
      { id: 'a', object_uri: 's3://b/exposed/1/x' },
      { id: 'c', object_uri: 's3://b/exposed/2/y' },
    ];
    await sweepExpiredFiles();
    expect(deleteMock.mock.calls.map((c) => c[0])).toEqual([
      's3://b/exposed/1/x',
      's3://b/exposed/2/y',
    ]);
    expect(deletedRowIds).toEqual(['a', 'c']);
  });

  it('leaves the row when the S3 delete fails (retried next sweep)', async () => {
    expiredRows = [{ id: 'a', object_uri: 's3://b/exposed/1/x' }];
    deleteMock.mockRejectedValueOnce(new Error('s3 down'));
    await sweepExpiredFiles();
    expect(deletedRowIds).toEqual([]);
  });

  it('no-ops when nothing is expired', async () => {
    await sweepExpiredFiles();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(deletedRowIds).toEqual([]);
  });
});
