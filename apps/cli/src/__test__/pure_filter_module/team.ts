// `@lf-platform/team`'s `is-member` (`team.isMember` in a program) and
// `user-for` (`team.userFor`, a member's record, or none for a stranger), as a
// team host serves them: pure, and backed by `members.json` beside it (a
// member's level is `admin` when `admins.json` beside it names them, else
// `read`). While a file `down` is there the
// module is out of reach: it will not start, and a call that finds it there
// ends the process. When `members.json` changes, the module tells its host
// that its answers changed (`ctx.host.invalidatePluginAnswers`). It answers
// an error of its own for `broken@acme.com`. Every question it is asked is
// logged to `asked.jsonl`.

const { appendFileSync, existsSync, readFileSync, watchFile } = require('node:fs');
const { join } = require('node:path');

const MODULE_KIT = process.env.LF_TEST_MODULE_KIT;
if (MODULE_KIT === undefined) throw new Error('LF_TEST_MODULE_KIT names the module kit');
const { defineModule } = require(join(MODULE_KIT, 'define.ts'));

const MEMBERS = join(__dirname, 'members.json');
const ADMINS = join(__dirname, 'admins.json');
const DOWN = join(__dirname, 'down');
if (existsSync(DOWN)) process.exit(1);

// The host's doors, as a call handed them: a change to the list is said there.
let host: { invalidatePluginAnswers(input: { plugin: string; args?: unknown[] }): Promise<void> } | undefined;
watchFile(MEMBERS, { interval: 100 }, () => {
  void host?.invalidatePluginAnswers({ plugin: 'is-member' }).then(() => appendFileSync(join(__dirname, 'asked.jsonl'), `${JSON.stringify({ invalidated: 'is-member' })}\n`));
});

module.exports = defineModule({
  kind: 'plugin',
  name: '@lf-platform/team',
  credentials: [],
  plugins: [
    {
      priced: false,
      pure: true,
      signature: {
        name: 'is-member',
        description: 'Whether the address is a member of the team.',
        params: [{ name: 'email', type: { kind: 'branded', of: { kind: 'string' }, brands: ['claim:email/address'] }, required: true }],
        dataDependency: 'none',
        additions: {},
        effects: {},
        output: { kind: 'value', type: { kind: 'boolean' } },
      },
    },
    {
      priced: false,
      pure: true,
      signature: {
        name: 'user-for',
        description: 'The team member the address is, or none.',
        params: [{ name: 'claim', type: { kind: 'branded', of: { kind: 'string' }, brands: ['claim:email/address'] }, required: true }],
        dataDependency: 'none',
        additions: {},
        effects: {},
        output: {
          kind: 'record',
          fields: {
            Id: { type: { kind: 'string' } },
            Email: { type: { kind: 'branded', of: { kind: 'string' }, brands: ['claim:email/address'] } },
            Name: { type: { kind: 'string' } },
            Level: { type: { kind: 'enum', values: ['read', 'write', 'admin'] } },
          },
          optional: true,
        },
      },
    },
  ],
  create: (ctx: { host: NonNullable<typeof host> }) => {
    host = ctx.host;
    return {
      invokePlugin: async ({ name, config }: { name: string; config: Record<string, unknown> }) => {
        if (existsSync(DOWN)) process.exit(1);
        const email = name === 'user-for' ? config.claim : config.email;
        appendFileSync(join(__dirname, 'asked.jsonl'), `${JSON.stringify(name === 'user-for' ? { userFor: email } : { email })}\n`);
        if (email === 'broken@acme.com') throw new Error('the directory refused this address');
        const members: unknown = JSON.parse(readFileSync(MEMBERS, 'utf8'));
        const member = Array.isArray(members) && members.includes(email);
        if (name !== 'user-for') return { data: { value: member } };
        if (!member || typeof email !== 'string') return {};
        const admins: unknown = existsSync(ADMINS) ? JSON.parse(readFileSync(ADMINS, 'utf8')) : [];
        return { data: { Id: `U-${email}`, Email: email, Name: email.split('@')[0], Level: Array.isArray(admins) && admins.includes(email) ? 'admin' : 'read' } };
      },
    };
  },
});
