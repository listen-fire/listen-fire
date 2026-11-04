// Going too deep on the WASM engine ends in MOVENG_CALL_DEPTH, whatever the
// limit and whatever the program (docs/contracts/run-limits.md). Its stack is
// fixed, so a limit it cannot hold ends where the stack does, and the message
// says so. Each run goes through the host, on the committed artifact.

import { mockCatalogSnapshot } from 'movement-lang';

import { tenantIdOf } from 'engine-contracts';
import { containerAssociation, type Adapter } from '../../translation_graph/adapter';
import { CALL_DEPTH_ENV_VAR, CallDepthExceeded } from '../call_depth';
import { credentialIdsFor, makeTestHost, type TestHostOverrides } from '../test_host';
import { MovementRunFailed, runFailureCause, runMovement } from '../../../public/movement-engine';

// The host's answers to the engine's environment requests, which a test makes
// throw by naming this mock's implementation.
jest.mock('../../../../movement-lang/wasm/env_services', () => {
  const actual = jest.requireActual('../../../../movement-lang/wasm/env_services');
  return { ...actual, answerEnvRequest: jest.fn(actual.answerEnvRequest) };
});
// eslint-disable-next-line import/first
import * as envServices from '../../../../movement-lang/wasm/env_services';

const catalog = mockCatalogSnapshot({
  adapters: {
    email: {
      constructionArgs: [{ name: 'credentials', kind: 'credential', required: true }],
      schema: { positions: { message: { properties: { subject: 'text' }, edges: {} } }, collections: {}, writableRoots: {} },
    },
  },
  credentials: { inbox_login: { adapters: ['email'] } },
});

const PRELUDE = ['import { email } from adapters', 'import { inbox_login } from credentials', 'inbox = connect email using inbox_login', ''].join('\n');

const adapter: Adapter = {
  adapterType: 'email',
  supportedTriggers: [],
  runtimeCapabilities: () => ({ traversal: { incoming: false, edgeProperties: false }, resources: false }),
  listEntryPoints: async () => [],
  describe: async () => null,
  resolveEntity: async () => ({ candidates: [] }),
  getFieldValue: async () => undefined,
  getRelated: async () => [],
  createRecord: async () => ({ adapterType: 'email', externalId: 'r1', data: {} }),
  updateRecord: async (input) => ({ adapterType: 'email', externalId: input.externalId, data: {}, association: containerAssociation(input) }),
  deleteRecord: async () => ({}),
};

const CALL_DEPTH_VAR = CALL_DEPTH_ENV_VAR;
const limitBefore = process.env[CALL_DEPTH_VAR];
afterAll(() => restore(CALL_DEPTH_VAR, limitBefore));
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** How the run ended: nothing thrown, or the cause of its failure. */
async function ended(source: string, limit?: number, options: { maxSegmentSeconds?: number; control?: TestHostOverrides['control'] } = {}): Promise<unknown> {
  try {
    await run(source, limit, options);
    return undefined;
  } catch (error) {
    return runFailureCause(error) ?? error;
  }
}

function run(source: string, limit: number | undefined, { maxSegmentSeconds, control }: { maxSegmentSeconds?: number; control?: TestHostOverrides['control'] } = {}) {
  restore(CALL_DEPTH_VAR, limit === undefined ? undefined : String(limit));
  return runMovement({
    source: PRELUDE + source,
    movementName: 'm',
    event: { pipelineInputId: 'p', adapterType: 'email', triggerType: 'webhook', payload: {} },
    teamId: tenantIdOf('00000000-0000-0000-0000-0000000000a1'),
    catalog,
    credentialIds: credentialIdsFor(catalog, (name) => `cred-${name}`),
    ...(maxSegmentSeconds !== undefined ? { maxSegmentSeconds } : {}),
    host: makeTestHost({ adapters: { resolve: () => adapter }, ...(control !== undefined ? { control } : {}) }),
  });
}

function endedWhereTheStackRanOut(cause: unknown, limit: number, shape: string): void {
  if (!(cause instanceof CallDepthExceeded)) throw new Error(`${shape}, limit ${limit}: ended with ${String(cause)}`);
  expect(cause.code).toBe('MOVENG_CALL_DEPTH');
  expect(cause.stackRanOut).toBe(true);
  expect(cause.limit).toBe(limit);
  expect(cause.message).toContain("the engine's stack ran out");
  expect(cause.message).toContain(`limit of ${limit}`);
}

const START = 'function m(msg: <inbox-[:message]->>) { return down(100000) }';
const recursion = (body: string): string => `function down(n: <number>): <number> {\n  if (n <= 0) { return 0 }\n  ${body}\n}\n${START}`;
const PLAIN = recursion('return 1 + down(n - 1)');
/** One call that nests its next as deep as the parser takes: what makes a
 *  call's frames as large as text can make them. */
const LARGE_FRAMES = recursion(`return ${'(1 + '.repeat(120)}down(n - 1)${')'.repeat(120)}`);

describe('the WASM engine, going too deep', () => {
  it('ends where its stack does when the limit is more than it holds', async () => {
    for (const limit of [300, 1000, 10000]) {
      endedWhereTheStackRanOut(await ended(PLAIN, limit), limit, 'plain');
      endedWhereTheStackRanOut(await ended(LARGE_FRAMES, limit), limit, 'large frames');
    }
  });

  it('names the calls it was inside, and keeps what the run had done', async () => {
    const raw = await run(PLAIN, 300).catch((error: unknown) => error);
    expect(raw).toBeInstanceOf(MovementRunFailed);
    const cause = runFailureCause(raw);
    if (!(cause instanceof CallDepthExceeded)) throw new Error(`ended with ${String(cause)}`);
    expect(cause.chain.slice(0, 2)).toEqual(['m', 'down']);
    expect(cause.chain.length).toBeGreaterThan(100);
    expect(cause.chain.length).toBeLessThan(301);
    expect(cause.message).toMatch(/^MOVENG_CALL_DEPTH: the engine's stack ran out at 'm → down/);
  });

  it('ends where its stack does on a program too large for even the default limit', async () => {
    endedWhereTheStackRanOut(await ended(LARGE_FRAMES), 32, 'large frames');
  });

  it('holds the limit itself wherever the stack holds it', async () => {
    const cause = await ended(PLAIN, 100);
    if (!(cause instanceof CallDepthExceeded)) throw new Error(`ended with ${String(cause)}`);
    expect(cause.stackRanOut).toBe(false);
    expect(cause.message).toContain('call depth limit reached');
    expect(cause.message).toContain('is 100.');
  });

  it('runs what it ran before the stack was checked', async () => {
    // As deep as a plain recursion went on a 2 MiB stack (between 230 and 240).
    expect(await ended(recursion('return 1 + down(n - 1)').replace('down(100000)', 'down(230)'), 1000)).toBeUndefined();
    expect(await ended(LARGE_FRAMES.replace('down(100000)', 'down(4)'))).toBeUndefined();
  });

  it('ends coded, whatever the recursion goes through', async () => {
    const shapes: Array<[string, string]> = [
      ['through another function', `function down(n: <number>): <number> {\n  if (n <= 0) { return 0 }\n  return 1 + other(n - 1)\n}\nfunction other(n: <number>): <number> { return down(n) }\n${START}`],
      ['as a statement', recursion('x = down(n - 1)\n  return x + 1')],
      ['in a condition', `function down(n: <number>): <number> {\n  if (n > 0 && down(n - 1) > 0) { return 1 }\n  return 0\n}\n${START}`],
      ['as an argument', `function id(n: <number>): <number> { return n }\n${recursion('return id(down(n - 1))')}`],
      ['a closure by its name', 'function m(msg: <inbox-[:message]->>) {\n  f = (n: <number>): <number> => {\n    if (n <= 0) { return 0 }\n    return 1 + f(n - 1)\n  }\n  return f(100000)\n}'],
      ['a closure around a closure', 'function down(n: <number>, g: <(x: <number>) => <number>>): <number> {\n  if (n <= 0) { return g(0) }\n  return down(n - 1, (x) => g(x) + 1)\n}\nfunction m(msg: <inbox-[:message]->>) { return down(100000, (x) => x) }'],
      ['a map', recursion('r = map([n], (x) => down(x - 1))\n  return 1')],
      ['a function handed to a map by name', 'function m(msg: <inbox-[:message]->>) {\n  g = (x: <number>): <number[]> => {\n    return map([x], g)\n  }\n  return g(1)\n}'],
      ['all', recursion('r = all(() => { return down(n - 1) })\n  return 1')],
      ['race', recursion('r = race(() => { return down(n - 1) })\n  return 1')],
      ['a body nested as deep as the parser takes', recursion(`${'if (n > 0) { '.repeat(100)}x = down(n - 1)${' }'.repeat(100)}\n  return 1`)],
      ['an expression written out in a map, as deep as the parser takes', recursion(`r = map([n], (x) => ${'(1 + '.repeat(100)}down(x - 1)${')'.repeat(100)})\n  return 1`)],
    ];
    for (const [shape, source] of shapes) {
      endedWhereTheStackRanOut(await ended(source, 10000), 10000, shape);
    }
  });

  it("ends coded when V8's stack runs out first, on a value nested deep", async () => {
    const nested = (levels: number, end: string): string =>
      `function m(msg: <inbox-[:message]->>) {\n  x = reduce([${Array(levels).fill('1').join(',')}], (acc, i) => { return { v: acc } }, {})\n  ${end}\n}`;
    expect(await ended(nested(2000, 'return x'))).toBeUndefined();
    for (const end of ['return 1', 'return x']) {
      const cause = await ended(nested(5000, end));
      endedWhereTheStackRanOut(cause, 32, `5000 levels, ${end}`);
    }
  });

  it("leaves a RangeError thrown in the host's own answer a failed answer, not the engine's stack", async () => {
    const answer = jest.mocked(envServices.answerEnvRequest);
    const actual = jest.requireActual<typeof envServices>('../../../../movement-lang/wasm/env_services').answerEnvRequest;
    answer.mockImplementation(() => {
      throw new RangeError('Maximum call stack size exceeded');
    });
    try {
      const cause = await ended(`function m(msg: <inbox-[:message]->>) {\n  return Text.slug("café")\n}`);
      expect(cause).not.toBeInstanceOf(CallDepthExceeded);
      expect(String(cause)).toContain('the environment import refused');
      expect(String(cause)).toContain('Maximum call stack size exceeded');
    } finally {
      answer.mockImplementation(actual);
    }
  });

  it('ends coded when a deep value meets a deep recursion', async () => {
    const source = `function down(n: <number>, v: <json>): <json> {\n  if (n <= 0) { return v }\n  w = { v: v }\n  return down(n - 1, v)\n}\nfunction m(msg: <inbox-[:message]->>) {\n  x = reduce([${Array(1500).fill('1').join(',')}], (acc, i) => { return { v: acc } }, {})\n  return down(100000, x)\n}`;
    endedWhereTheStackRanOut(await ended(source, 10000), 10000, 'deep value, deep recursion');
  });

  it('stops a run deep in its calls, and lets them all go', async () => {
    let asked = 0;
    const cause = await ended(PLAIN, 180, {
      maxSegmentSeconds: 1,
      control: {
        cancel: {
          // The wall clock passes with the run about as deep as its stack holds.
          cancelled: async () => {
            asked += 1;
            if (asked === 170) await new Promise((resolve) => setTimeout(resolve, 1100));
            return false;
          },
          cancelledNow: async () => false,
        },
      },
    });
    expect(asked).toBeGreaterThanOrEqual(170);
    expect(String(cause)).toContain('MOVENG_LIMIT_WALL_CLOCK');
  });
});
