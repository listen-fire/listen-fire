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
 *
 * The page waits on more than the list, so `--procedure <name>` points the
 * resolver mode at any one of the calls it makes on load:
 *
 *   list           the holdings themselves (the default)
 *   year-options   the filter bar's year range
 *   user-context   the signed-in user, their teams and their permissions
 */
import { writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';

import Pg from 'pg';

// Counting happens at the driver, so it counts what the database was actually
// asked — one tick per statement, whoever built it.
let statements = 0;
let counting = false;
const byStatement = new Map<string, { count: number; ms: number }>();
// Start/end of every statement, so the time the resolver spent with at least
// one query outstanding can be told apart from the sum of query times — which
// counts a fan-out of twenty parallel queries twenty times over.
const intervals: Array<[number, number]> = [];
const clientQuery = Pg.Client.prototype.query;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
Pg.Client.prototype.query = function (this: any, ...args: any[]) {
  if (!counting) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (clientQuery as any).apply(this, args);
  }

  statements += 1;
  const text: string = typeof args[0] === 'string' ? args[0] : (args[0]?.text ?? '?');
  const signature = text.replace(/\s+/g, ' ').slice(0, 110);
  const tally = byStatement.get(signature) ?? { count: 0, ms: 0 };
  tally.count += 1;
  byStatement.set(signature, tally);

  const startedAt = process.hrtime.bigint();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const running = (clientQuery as any).apply(this, args);
  if (running && typeof running.then === 'function') {
    const done = () => {
      const endedAt = process.hrtime.bigint();
      tally.ms += Number(endedAt - startedAt) / 1e6;
      intervals.push([Number(startedAt) / 1e6, Number(endedAt) / 1e6]);
    };
    running.then(done, done);
  }
  return running;
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

/** The totals row as its own request, which is how the page used to get it —
 *  kept so the totals the list now returns can be shown to agree with it. */
async function callTotals() {
  return runInContext(
    async () => {
      const caller = trpcRouter.createCaller({ authorise: async () => {} });
      const startedAt = process.hrtime.bigint();
      const totals = await caller.views.investments.getPortfolioTotals({
        filter: PAGE_INPUT.filter,
        config: {
          currency: PAGE_INPUT.config.currency,
          aggregation: PAGE_INPUT.config.aggregation,
        },
      } as never);
      return { totals, ms: Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6) };
    },
    { email: USER_EMAIL },
    { teamId: TEAM_ID },
  );
}

type Caller = ReturnType<typeof trpcRouter.createCaller>;

/** The calls the portfolio page makes on load, each with the input the page
 *  itself sends. */
const PROCEDURES = {
  list: (caller: Caller) => caller.views.investments.getPortfolioInvestments(PAGE_INPUT as never),
  'year-options': (caller: Caller) =>
    caller.views.investments.getYearOptions({
      filter: PAGE_INPUT.filter,
      config: {
        currency: PAGE_INPUT.config.currency,
        showDetails: PAGE_INPUT.config.showDetails,
      },
      scope: PAGE_INPUT.config.aggregation,
    } as never),
  'user-context': (caller: Caller) => caller.models.user.context(),
} as const;

type ProcedureName = keyof typeof PROCEDURES;

function procedureName(raw: string | undefined): ProcedureName {
  if (raw === undefined) {
    return 'list';
  }
  if (!(raw in PROCEDURES)) {
    throw new Error(`unknown --procedure '${raw}' (expected: ${Object.keys(PROCEDURES).join(', ')})`);
  }
  return raw as ProcedureName;
}

/** One call, in its own Context — which is the scope every per-request memo
 *  and batch lives in, so two calls sharing one would flatter the second. */
async function callOnce(procedure: ProcedureName) {
  return runInContext(
    async () => {
      const caller = trpcRouter.createCaller({ authorise: async () => {} });
      return PROCEDURES[procedure](caller);
    },
    { email: USER_EMAIL },
    { teamId: TEAM_ID },
  );
}

async function measureResolver(procedure: ProcedureName, rowsOut: string | undefined) {
  // One warm pass first: the first call of the process pays for pools,
  // prepared statements and JIT, and that cost is not the page's.
  await callOnce(procedure);

  return runInContext(
    async () => {
      const caller = trpcRouter.createCaller({ authorise: async () => {} });

      statements = 0;
      intervals.length = 0;
      counting = true;

      // A timer that should fire every 2ms fires late by exactly as long as
      // something else held the loop. Summed, that is the time this one call
      // makes every OTHER request on the server wait.
      const TICK_MS = 2;
      let blockedMs = 0;
      let tickedAt = process.hrtime.bigint();
      const ticker = setInterval(() => {
        const now = process.hrtime.bigint();
        const late = Number(now - tickedAt) / 1e6 - TICK_MS;
        if (late > 0) {
          blockedMs += late;
        }
        tickedAt = now;
      }, TICK_MS);

      const cpuAtStart = process.cpuUsage();
      const startedAt = process.hrtime.bigint();
      const result = (await PROCEDURES[procedure](caller)) as { items?: Row[]; totals?: unknown };
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const cpu = process.cpuUsage(cpuAtStart);
      clearInterval(ticker);
      counting = false;

      const body = JSON.stringify(result);
      const gzipped = gzipSync(Buffer.from(body)).length;
      const items = result.items;

      if (items && rowsOut) {
        writeFileSync(rowsOut, `${JSON.stringify(comparableRows(items), null, 1)}\n`);
      }

      const breakdown = Array.from(byStatement.entries())
        .sort((a, b) => b[1].ms - a[1].ms)
        .slice(0, 12)
        .map(
          ([signature, tally]) =>
            `${String(tally.count).padStart(5)}x ${String(Math.round(tally.ms)).padStart(6)}ms  ${signature}`,
        );

      return {
        procedure,
        rows: items?.length,
        totals: result.totals,
        resolverMs: Math.round(ms),
        // This process does nothing else while the resolver runs, so its CPU
        // over the window is the resolver's own — including the pg driver's
        // parsing of everything the database sent back, and the garbage
        // collection that parsing causes, both of which run off the loop.
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        eventLoopBlockedMs: Math.round(blockedMs),
        databaseWallMs: Math.round(databaseWallMs()),
        statements,
        bytes: body.length,
        bytesGzipped: gzipped,
        rowsFile: items ? rowsOut : undefined,
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
  const url = `${API_URL}/api/trpc/views.investments.getPortfolioInvestments?input=${input}`;

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

/** Wall-clock time with at least one statement in flight — the part of the
 *  resolver the database was actually being waited on for. */
function databaseWallMs(): number {
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let openedAt: number | null = null;
  let closesAt = 0;
  for (const [from, to] of sorted) {
    if (openedAt === null) {
      openedAt = from;
      closesAt = to;
    } else if (from > closesAt) {
      total += closesAt - openedAt;
      openedAt = from;
      closesAt = to;
    } else if (to > closesAt) {
      closesAt = to;
    }
  }
  if (openedAt !== null) {
    total += closesAt - openedAt;
  }
  return total;
}

async function main() {
  const args = process.argv.slice(2);

  const result = args.includes('--http')
    ? { mode: 'http', ...(await measureHttp()) }
    : {
        mode: 'resolver',
        ...(await measureResolver(procedureName(flag(args, 'procedure')), flag(args, 'rows'))),
        ...(args.includes('--check-totals') ? { separateTotalsRequest: await callTotals() } : {}),
      };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
