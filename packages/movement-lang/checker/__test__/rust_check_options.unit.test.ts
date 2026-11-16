// What the TypeScript binding hands the Rust checker and reads back beyond a
// diagnostic's code and message: the plugin a host limits a listen's senders
// with (`limitingFunction`), which puts the check in an open listen's fix on
// an upgrade, and the library a diagnostic came from (`file`).

import { LANGUAGE_VERSION } from '../../language_version';
import type { CatalogSnapshot } from '../../service/snapshot';
import { checkSourceInRust } from '../rust_checker';

const EMAIL = { kind: 'branded', of: 'text', brands: ['claim:email/address'] };

// Read as a host reads a snapshot it was sent.
const SNAPSHOT: CatalogSnapshot = JSON.parse(JSON.stringify({
  adapters: {
    slack: {
      canFire: true,
      constructionArgs: [],
      listensLimitedBefore: '0.16.0',
      schemas: {
        '': {
          positions: { Message: { properties: { Channel: 'text', 'User Email': EMAIL }, edges: {} } },
          collections: { Messages: { target: 'Message', listenable: true, delivery: 'connection' } },
          writableRoots: {},
        },
      },
    },
  },
  credentials: {},
  plugins: {
    '@lf-platform/team/isMember': {
      args: ['e'],
      priced: false,
      requiredArgs: ['e'],
      argTypes: { e: EMAIL },
      effects: {},
      output: { kind: 'value', type: 'boolean' },
      package: '@lf-platform/team',
      name: 'isMember',
      pure: true,
      maxAgeSeconds: 300,
    },
  },
  files: { 'lib/broken': { source: 'export function helper( {' } },
}));

const SLACK = 'import { slack } from adapters\ns = connect slack\nfunction f(m: <s-[:Message]->>) { return m.Channel }\nlisten to s-[m:Messages]-> fire f\n';

describe('the Rust checker through its binding', () => {
  it('offers an open listen the check that calls the limiting function, only when the host names it', () => {
    const upgrading = { languageVersion: LANGUAGE_VERSION, upgradingFrom: '0.15.3' };
    const open = (limitingFunction?: string) =>
      checkSourceInRust(SLACK, SNAPSHOT, { ...upgrading, ...(limitingFunction !== undefined ? { limitingFunction } : {}) }).filter((d) => d.code === 'MOV_LISTEN_NOW_OPEN');
    expect(open()).toEqual([expect.objectContaining({ severity: 'warning', upgrade: true })]);
    expect(open()[0]).not.toHaveProperty('fix');
    const fix = open('@lf-platform/team/isMember')[0]?.fix;
    expect(fix?.safe).toBeUndefined();
    expect(fix?.edits.map((edit) => edit.text)).toEqual([
      '\nimport { `@lf-platform/team` as team } from plugins',
      's-[m:Messages WHERE team.isMember(m.`User Email`)]->',
    ]);
  });

  it("names the library a diagnostic came from in `file`", () => {
    const found = checkSourceInRust('import { helper } from "lib/broken"\nfunction go(t: <text>) {\n  x = 1\n}\n', SNAPSHOT, { languageVersion: LANGUAGE_VERSION });
    expect(found).toEqual([expect.objectContaining({ code: 'MOV_IMPORT_FILE_INVALID', file: 'lib/broken' })]);
  });
});
