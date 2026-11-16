// `@lf-platform/team`'s `is-member` (`team.isMember` in a program), as a team host serves it: pure, and
// backed by `members.json` beside it. While a file `down` is there the
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
  ],
  create: (ctx: { host: NonNullable<typeof host> }) => {
    host = ctx.host;
    return {
      invokePlugin: async ({ config }: { config: Record<string, unknown> }) => {
        if (existsSync(DOWN)) process.exit(1);
        appendFileSync(join(__dirname, 'asked.jsonl'), `${JSON.stringify({ email: config.email })}\n`);
        if (config.email === 'broken@acme.com') throw new Error('the directory refused this address');
        const members: unknown = JSON.parse(readFileSync(MEMBERS, 'utf8'));
        return { data: { value: Array.isArray(members) && members.includes(config.email) } };
      },
    };
  },
});
