import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { staticConfigFromEnv, type StaticDirectoryConfig } from '../config';
import { createStaticDirectory } from '../directory';

const TEAM = '11111111-1111-1111-1111-111111111111';
const OTHER_TEAM = '22222222-2222-2222-2222-222222222222';

const config: StaticDirectoryConfig = {
  team: { id: TEAM, name: 'Local' },
  users: [
    { id: 'user-1', email: 'Someone@Example.com', displayName: 'Someone', hasAccess: true },
    { id: 'user-2', email: 'invited@example.com', hasAccess: false },
  ],
};

function directoryFile(contents: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'principal-')), 'directory.json');
  writeFileSync(file, JSON.stringify(contents), 'utf8');
  return file;
}

describe('the static directory', () => {
  const directory = createStaticDirectory(config);

  it('resolves a member by id and by email, case-insensitively', async () => {
    await expect(directory.userById({ id: 'user-1', teamId: TEAM })).resolves.toEqual(
      config.users[0],
    );
    await expect(
      directory.userByEmail({ email: ' someone@example.COM ', teamId: TEAM }),
    ).resolves.toEqual(config.users[0]);
  });

  it('reports whether the user may act, rather than omitting them', async () => {
    const invited = await directory.userById({ id: 'user-2', teamId: TEAM });
    expect(invited).not.toBeNull();
    expect(invited?.hasAccess).toBe(false);
    await expect(directory.members(TEAM)).resolves.toHaveLength(2);
  });

  it('answers nothing for a team it does not serve', async () => {
    await expect(directory.userById({ id: 'user-1', teamId: OTHER_TEAM })).resolves.toBeNull();
    await expect(
      directory.userByEmail({ email: 'someone@example.com', teamId: OTHER_TEAM }),
    ).resolves.toBeNull();
    await expect(directory.members(OTHER_TEAM)).resolves.toEqual([]);
    await expect(directory.team(OTHER_TEAM)).resolves.toBeNull();
  });

  it('resolves unknown people to null, not to a partial record', async () => {
    await expect(directory.userById({ id: 'nobody', teamId: TEAM })).resolves.toBeNull();
    await expect(
      directory.userByEmail({ email: 'nobody@example.com', teamId: TEAM }),
    ).resolves.toBeNull();
  });

  it('names the team it serves', async () => {
    await expect(directory.team(TEAM)).resolves.toEqual({ id: TEAM, name: 'Local' });
  });

  it('ties a login email to the one team, case-insensitively', async () => {
    await expect(directory.teamsForEmail(' SOMEONE@example.com ')).resolves.toEqual([
      { teamId: TEAM, userId: 'user-1' },
    ]);
  });

  it('reports the tie of an un-activated user too — the caller gates, not this', async () => {
    await expect(directory.teamsForEmail('invited@example.com')).resolves.toEqual([
      { teamId: TEAM, userId: 'user-2' },
    ]);
  });

  it('ties nothing to an address it has never heard of', async () => {
    await expect(directory.teamsForEmail('stranger@example.com')).resolves.toEqual([]);
  });
});

describe('the static directory config file', () => {
  it('loads users, defaulting hasAccess to granted', async () => {
    const file = directoryFile({
      users: [
        { id: 'user-1', email: 'a@example.com' },
        { id: 'user-2', hasAccess: false },
      ],
    });

    const parsed = staticConfigFromEnv({
      LISTEN_FIRE_API_KEY: 'k',
      LISTEN_FIRE_TEAM_ID: TEAM,
      LISTEN_FIRE_DIRECTORY_FILE: file,
    });

    expect(parsed.directory.users).toEqual([
      { id: 'user-1', email: 'a@example.com', displayName: undefined, hasAccess: true },
      { id: 'user-2', email: undefined, displayName: undefined, hasAccess: false },
    ]);
  });

  it('fails loudly on a malformed file', () => {
    const badShape = directoryFile({ users: [{ email: 'a@example.com' }] });
    expect(() =>
      staticConfigFromEnv({ LISTEN_FIRE_API_KEY: 'k', LISTEN_FIRE_DIRECTORY_FILE: badShape }),
    ).toThrow(/users\[0\]: "id"/);

    const notAList = directoryFile({ users: 'someone' });
    expect(() =>
      staticConfigFromEnv({ LISTEN_FIRE_API_KEY: 'k', LISTEN_FIRE_DIRECTORY_FILE: notAList }),
    ).toThrow(/"users" must be an array/);
  });
});
