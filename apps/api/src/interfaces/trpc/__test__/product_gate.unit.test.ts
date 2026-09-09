// The composition is a boot-time fact, memoised on first read, so each shape
// is exercised in its own module registry with its own environment.

type Gate = typeof import('../product_gate');

function gateFor(products: string, principal = 'core'): Gate {
  let gate: Gate | undefined;
  jest.isolateModules(() => {
    process.env.LISTEN_FIRE_PRODUCTS = products;
    process.env.LISTEN_FIRE_PRINCIPAL = principal;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    gate = require('../product_gate') as Gate;
  });
  if (gate === undefined) throw new Error('module did not load');
  return gate;
}

const ORIGINAL = { ...process.env };
afterEach(() => {
  process.env.LISTEN_FIRE_PRODUCTS = ORIGINAL.LISTEN_FIRE_PRODUCTS;
  process.env.LISTEN_FIRE_PRINCIPAL = ORIGINAL.LISTEN_FIRE_PRINCIPAL;
});

describe('trpcPathIsMounted', () => {
  it('serves everything in the composed deployment', () => {
    const { trpcPathIsMounted } = gateFor('all');
    expect(trpcPathIsMounted('views.knowledge.getOntology')).toBe(true);
    expect(trpcPathIsMounted('views.portfolio.list')).toBe(true);
    expect(trpcPathIsMounted('views.journey.list')).toBe(true);
  });

  it('refuses an unmounted product in the Tiny shape', () => {
    const { trpcPathIsMounted } = gateFor('core,valuations,automations');
    expect(trpcPathIsMounted('views.knowledge.getOntology')).toBe(false);
    expect(trpcPathIsMounted('views.movement.list')).toBe(true);
    expect(trpcPathIsMounted('views.investments.list')).toBe(true);
  });

  it('drops the residual routers outside the composed deployment', () => {
    const { trpcPathIsMounted } = gateFor('core,valuations,automations');
    expect(trpcPathIsMounted('views.journey.list')).toBe(false);
    expect(trpcPathIsMounted('views.ops.list')).toBe(false);
    expect(trpcPathIsMounted('views.admin.teams')).toBe(false);
  });

  it('keeps a forked router wherever either owner runs', () => {
    expect(gateFor('core,automations').trpcPathIsMounted('views.handbook.read')).toBe(true);
    expect(gateFor('core,knowledge').trpcPathIsMounted('views.handbook.read')).toBe(true);
    expect(gateFor('core,valuations').trpcPathIsMounted('views.handbook.read')).toBe(false);
  });

  it('leaves the models tree and unclaimed routers alone', () => {
    const { trpcPathIsMounted } = gateFor('asks', 'static');
    expect(trpcPathIsMounted('models.user.context')).toBe(true);
    expect(trpcPathIsMounted('views.note.extract')).toBe(true);
    expect(trpcPathIsMounted('views.account.setPassword')).toBe(true);
  });
});

describe('productGateMiddleware over a batched HTTP request', () => {
  // The real adapter, not a stand-in: batching is the whole point of the
  // middleware, and only `resolveHTTPResponse` resolves a comma-separated path
  // the way the browser's httpBatchLink asks for one.
  function batch(paths: string): Promise<{ status: number; body: unknown }> {
    let answer: Promise<{ status: number; body: unknown }> | undefined;

    jest.isolateModules(() => {
      process.env.LISTEN_FIRE_PRODUCTS = 'core,valuations,automations';
      process.env.LISTEN_FIRE_PRINCIPAL = 'core';
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { trpc } = require('../trpc') as typeof import('../trpc');
      const { productGateMiddleware } = require('../product_gate') as Gate;
      const { resolveHTTPResponse } =
        require('@trpc/server/http') as typeof import('@trpc/server/http');
      /* eslint-enable @typescript-eslint/no-require-imports */

      const procedure = trpc.procedure.use(productGateMiddleware);
      const ok = procedure.query(() => 'served');
      const router = trpc.router({
        views: trpc.router({
          movement: trpc.router({ list: ok }),
          knowledge: trpc.router({ getOntology: ok }),
        }),
      });

      answer = resolveHTTPResponse({
        router,
        path: paths,
        req: {
          method: 'GET',
          query: new URLSearchParams({ batch: '1', input: '{}' }),
          headers: {},
          body: undefined,
        },
        createContext: async () => ({ authorise: async () => {} }),
      }).then((res) => ({
        status: res.status,
        body: JSON.parse(res.body ?? 'null') as unknown,
      }));
    });

    if (answer === undefined) throw new Error('module did not load');
    return answer;
  }

  it('serves the mounted member and refuses only the unmounted one', async () => {
    const { status, body } = await batch('views.movement.list,views.knowledge.getOntology');

    // 207: the batch as a whole neither succeeded nor failed, which is the
    // point — before this, the same request was a flat 404.
    expect(status).toBe(207);
    const [mounted, unmounted] = body as [
      { result?: { data: unknown } },
      { error?: { message: string; data: { code: string; httpStatus: number } } },
    ];

    expect(mounted.result?.data).toBe('served');
    expect(unmounted.error?.data.code).toBe('NOT_FOUND');
    expect(unmounted.error?.data.httpStatus).toBe(404);
    expect(unmounted.error?.message).toBe(
      'No such procedure here: views.knowledge.getOntology. This deployment does not run that product.',
    );
  });

  it('answers a lone unmounted procedure with a 404', async () => {
    const { status, body } = await batch('views.knowledge.getOntology');
    expect(status).toBe(404);
    expect((body as [{ error: { data: { code: string } } }])[0].error.data.code).toBe('NOT_FOUND');
  });
});

describe('refuseUnmountedWsMessage', () => {
  it('refuses a subscription to an unmounted product', () => {
    const { refuseUnmountedWsMessage } = gateFor('core,valuations,automations');
    const refusal = refuseUnmountedWsMessage(
      JSON.stringify({ id: 7, method: 'subscription', params: { path: 'views.knowledge.ontology.watch' } }),
    );
    expect(refusal).toBeDefined();
    const parsed = JSON.parse(refusal as string);
    expect(parsed.id).toBe(7);
    expect(parsed.error.data.code).toBe('NOT_FOUND');
  });

  it('lets a mounted product through, and anything it cannot read', () => {
    const { refuseUnmountedWsMessage } = gateFor('core,valuations,automations');
    expect(
      refuseUnmountedWsMessage(
        JSON.stringify({ id: 1, method: 'subscription', params: { path: 'views.triggers.watch' } }),
      ),
    ).toBeUndefined();
    expect(refuseUnmountedWsMessage('not json')).toBeUndefined();
    expect(refuseUnmountedWsMessage(JSON.stringify({ id: 1 }))).toBeUndefined();
  });

  it('checks every frame of a batched message', () => {
    const { refuseUnmountedWsMessage } = gateFor('core,valuations,automations');
    const refusal = refuseUnmountedWsMessage(
      JSON.stringify([
        { id: 1, params: { path: 'views.triggers.watch' } },
        { id: 2, params: { path: 'views.knowledge.ontology.watch' } },
      ]),
    );
    expect(JSON.parse(refusal as string).id).toBe(2);
  });
});

describe('the real viewsRouter is wired through the gate', () => {
  // The middleware only protects a router that was BUILT with the gated
  // procedure. Nothing makes that structural: a future router added to
  // views/index.ts with the raw `trpc.procedure` would be mounted everywhere
  // and no other test would notice. So walk the actual tree, call every
  // procedure it declares, and require the gate's refusal for each path whose
  // unit this shape does not run.
  //
  // Calling the procedure directly rather than through the HTTP adapter is
  // deliberate: the adapter answers a GET on a mutation with its OWN NOT_FOUND,
  // which would let a wholly ungated mutation pass this test.
  function callable(value: unknown): value is (opts: unknown) => Promise<unknown> {
    return typeof value === 'function';
  }

  // `TRPCError` comes out of the ISOLATED registry with the router: an
  // instanceof against this file's own copy of @trpc/server would be false for
  // every error the isolated tree throws, and the walk would read as ungated.
  function gatedShape(products: string) {
    let loaded:
      | {
          procedures: object;
          trpcPathIsMounted: Gate['trpcPathIsMounted'];
          TRPCError: typeof import('@trpc/server').TRPCError;
        }
      | undefined;

    jest.isolateModules(() => {
      process.env.LISTEN_FIRE_PRODUCTS = products;
      process.env.LISTEN_FIRE_PRINCIPAL = 'static';
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { viewsRouter } = require('../views') as typeof import('../views');
      const { trpcPathIsMounted } = require('../product_gate') as Gate;
      const { TRPCError } = require('@trpc/server') as typeof import('@trpc/server');
      /* eslint-enable @typescript-eslint/no-require-imports */
      loaded = { procedures: viewsRouter._def.procedures, trpcPathIsMounted, TRPCError };
    });

    if (loaded === undefined) throw new Error('module did not load');
    return loaded;
  }

  it('refuses every unmounted procedure the tree declares', async () => {
    const { procedures, trpcPathIsMounted, TRPCError } = gatedShape('knowledge');
    const unmounted: string[] = [];
    const served: string[] = [];

    for (const [name, procedure] of Object.entries(procedures)) {
      const path = `views.${name}`;
      if (trpcPathIsMounted(path)) continue;
      unmounted.push(path);

      if (!callable(procedure)) {
        served.push(path);
        continue;
      }

      // The gate runs ahead of every other middleware, so it answers with no
      // session and no input; anything that gets past it fails differently,
      // which is what `served` records.
      const outcome = await procedure({
        path,
        type: 'query',
        ctx: { authorise: async () => {} },
        rawInput: undefined,
      }).then(
        () => 'served',
        (error: unknown) =>
          error instanceof TRPCError && error.code === 'NOT_FOUND' ? 'refused' : 'served',
      );

      if (outcome === 'served') served.push(path);
    }

    // A knowledge-only shape leaves most of the tree unmounted. Without this
    // the assertion below would pass on an empty walk.
    expect(unmounted.length).toBeGreaterThan(20);
    expect(served).toEqual([]);
  });
});
