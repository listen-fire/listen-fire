// What a key minted with no scope list of its own is allowed to reach.
//
// The default used to be a fixed `['ingest', 'knowledge']`: `ingest` names no
// route in the tree, and every other product's surface was withheld — so a key
// minted on a five-unit installation was refused by valuations, asks and
// automations while looking, in the UI, like a key for the installation. The
// default is now read off the composition (`installedScopes`), which is also
// what keeps it from ever naming a surface this deployment does not mount.

import { ApiKeyService } from '..';
import { currentContext } from '../../context';

jest.mock('../../context', () => ({ currentContext: jest.fn() }));

const TEAM_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';

const create = jest.fn(async ({ data }: { data: Record<string, unknown> }) => ({
  id: 'key-1',
  ...data,
}));

/** The scopes the created row was written with. */
async function mintedScopes(input?: { scopes?: string[] }): Promise<unknown> {
  create.mockClear();
  await ApiKeyService.create({ name: 'a key', ...input });
  return create.mock.calls[0]![0].data.scopes;
}

beforeAll(() => {
  // The composition is a boot-time fact, resolved once on first read, so it is
  // set before anything asks for it. This is the composed deployment.
  process.env.LISTEN_FIRE_PRINCIPAL = 'core';
  process.env.LISTEN_FIRE_PRODUCTS = 'core,valuations,automations,knowledge,asks';
});

beforeEach(() => {
  (currentContext as jest.Mock).mockReturnValue({
    user: { id: USER_ID, teamId: TEAM_ID },
    prisma: { apiKey: { create } },
  });
});

describe('ApiKeyService.create — default scopes', () => {
  it('grants every scope the installation mounts a surface for', async () => {
    expect(await mintedScopes()).toEqual([
      'valuations',
      'automation',
      'knowledge',
      'asks',
      'system',
    ]);
  });

  it('never grants the retired `ingest` scope, which gates nothing', async () => {
    expect(await mintedScopes()).not.toContain('ingest');
  });

  it('leaves an explicit scope list exactly as the caller wrote it', async () => {
    expect(await mintedScopes({ scopes: ['valuations'] })).toEqual(['valuations']);
    expect(await mintedScopes({ scopes: [] })).toEqual([]);
  });
});
