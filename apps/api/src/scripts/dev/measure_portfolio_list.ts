/**
 * Measure what one portfolio-list load costs: resolver time, statements issued,
 * bytes on the wire, and the per-row numbers themselves.
 *
 * The numbers only mean something against a portfolio with real shape, so this
 * is pointed at whichever database `DATABASE_URL` names — in practice a local
 * copy of the production data rather than the dev-loop fixture:
 *
 *   DATABASE_URL=postgresql://…/listenfire_port_rehearsal \
 *   DATABASE_URL_READONLY=$DATABASE_URL \
 *   MEASURE_TEAM_ID=… MEASURE_USER_EMAIL=… \
 *   pnpm --filter api dev:measure-portfolio --rows before.json
 *
 * The input is the one the portfolio page sends (an unfiltered company-level
 * list, USD, grouped by investment date), so a run here is the page's own load.
 *
 * Modes:
 *   (default)  call the resolver in process — resolver ms, statements, bytes
 *   --http     go over HTTP against a running API — wall-clock ms and the
 *              bytes actually transferred, plain and with `Accept-Encoding`
 *   --rows F   write every row's invested / retained / realised / value / MOIC
 *              to F, so a change can be proved to move no number
 */
import { writeFileSync } from 'fs';
import { gzipSync } from 'zlib';

import Pg from 'pg';

// Counting happens at the driver, so it counts what the database was actually
// asked — one tick per statement, whoever built it.
let statements = 0;
let counting = false;
const byStatement = new Map<string, number>();
const clientQuery = Pg.Client.prototype.query;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
Pg.Client.prototype.query = function (this: any, ...args: any[]) {
  if (counting) {
    statements += 1;
    const text: string = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '?');
    const signature = text.replace(/\s+/g, ' ').slice(0, 110);
    byStatement.set(signature, (byStatement.get(signature) ?? 0) + 1);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (clientQuery as any).apply(this, args);
};

import { runInContext } from '../../services/context/utils';
import { trpcRouter } from '../../interfaces/trpc';
import { generateJWT } from '../../lib/middleware/authentication/token';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set: the team and a member of it to measure as`);
  return value;
}

const TEAM_ID = requiredEnv('MEASURE_TEAM_ID');
const USER_EMAIL = requiredEnv('MEASURE_USER_EMAIL');
const API_URL = process.env.MEASURE_API_URL ?? 'http://localhost:3501';

/** Exactly what `apps/web`'s portfolio page sends: `toApiFilter(DEFAULT_FILTER)`
 *  and `toApiConfig(DEFAULT_CONFIG)`, whose `showDetails` is always true. */
const PAGE_INPUT = {
  filter: {},
  config: {
    currency: 'USD' as const,
    aggregation: 'company' as const,
    showDetails: true,
  },
  grouping: 'investment_date' as const,
};

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

type Row = {
  name: string;
  legal_entity_id: string;
  totalInvested: number | null;
  retainedAll: number;
  retainedInCompany: number;
  realizedValue: number;
  totalValue: number;
  moic: number | null;
};

/** The numbers a reader of the page would notice changing, keyed so two runs
 *  line up regardless of row order. */
function comparableRows(items: Row[]) {
  return items
    .map((i) => ({
      key: `${i.legal_entity_id}|${i.name}`,
      totalInvested: i.totalInvested,
      retainedAll: i.retainedAll,
      retainedInCompany: i.retainedInCompany,
      realizedValue: i.realizedValue,
      totalValue: i.totalValue,
      moic: i.moic,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** One call, in its own Context — which is the scope every per-request memo
 *  and batch lives in, so two calls sharing one would flatter the second. */
async function callList() {
  return runInContext(
    async () => {
      const caller = trpcRouter.createCaller({ authorise: async () => {} });
      return caller.views.investments.getPortfolioInvestments(PAGE_INPUT as never);
    },
    { email: USER_EMAIL },
    { teamId: TEAM_ID },
  );
}

async function measureResolver(rowsOut: string | undefined) {
  // One warm pass first: the first call of the process pays for pools,
  // prepared statements and JIT, and that cost is not the page's.
  await callList();

  return runInContext(
    async () => {
      const caller = trpcRouter.createCaller({ authorise: async () => {} });

      statements = 0;
      counting = true;
      const startedAt = process.hrtime.bigint();
      const result = await caller.views.investments.getPortfolioInvestments(PAGE_INPUT as never);
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      counting = false;

      const body = JSON.stringify(result);
      const gzipped = gzipSync(Buffer.from(body)).length;
      const items = result.items as unknown as Row[];
      const withoutTrace = JSON.stringify({
        items: items.map(({ ...row }) => ({ ...row, message: undefined })),
      }).length;

      if (rowsOut) {
        writeFileSync(rowsOut, `${JSON.stringify(comparableRows(items), null, 1)}\n`);
      }

      const breakdown = Array.from(byStatement.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 12)
        .map(([signature, count]) => `${String(count).padStart(5)}  ${signature}`);

      return {
        rows: items.length,
        resolverMs: Math.round(ms),
        statements,
        bytes: body.length,
        bytesWithoutTrace: withoutTrace,
        bytesGzipped: gzipped,
        rowsFile: rowsOut,
        breakdown,
      };
    },
    { email: USER_EMAIL },
    { teamId: TEAM_ID },
  );
}

async function measureHttp() {
  const token = generateJWT(USER_EMAIL);
  const input = encodeURIComponent(JSON.stringify(PAGE_INPUT));
  const url = `${API_URL}/trpc/views.investments.getPortfolioInvestments?input=${input}`;

  const call = async (acceptEncoding: string) => {
    const startedAt = process.hrtime.bigint();
    const response = await fetch(url, {
      headers: {
        cookie: `listen_fire_token=${token}`,
        'x-request-team-id': TEAM_ID,
        'accept-encoding': acceptEncoding,
      },
    });
    // Read to completion: the download is part of what the page waits for.
    const buffer = Buffer.from(await response.arrayBuffer());
    const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
    return {
      status: response.status,
      contentEncoding: response.headers.get('content-encoding'),
      ms: Math.round(ms),
      // `fetch` decompresses, so the transferred size is the server's own count.
      decodedBytes: buffer.length,
      wireBytes: Number(response.headers.get('content-length') ?? buffer.length),
    };
  };

  await call('identity');
  return {
    identity: await call('identity'),
    compressed: await call('gzip, deflate, br'),
  };
}

async function main() {
  const args = process.argv.slice(2);

  const result = args.includes('--http')
    ? { mode: 'http', ...(await measureHttp()) }
    : { mode: 'resolver', ...(await measureResolver(flag(args, 'rows'))) };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
