import { Context } from '..';

/**
 * Root cause of the MCP client-disconnect unhandledRejection (production):
 * `lib/middleware/context.ts`'s `contextInjector` does
 * `req.on('error', (err) => ctx.error(err))` with no await/catch on the
 * returned promise. `Context.error()` calls `this.emit('error', err)`, and
 * `Context` documents 'error' as a passive notification ("an error has
 * occurred within the context, and it will now start cleaning up") — but
 * `EventEmitter` special-cases the 'error' event: emitting it with zero
 * listeners attached THROWS the value synchronously instead of just doing
 * nothing. Inside an `async` method that throw becomes a rejected promise,
 * and nothing in `contextInjector`'s fire-and-forget call site ever attaches
 * a rejection handler to it — so it surfaces as a process-level
 * unhandledRejection. Any Context with no active listener (i.e. every
 * request outside an open DB transaction — see `enterTransaction`'s
 * `waitForEvent('error')`) hits this the moment its underlying request
 * aborts, which is why it shows up loudest on MCP's long-lived SSE streams
 * (a huge window for the client to disconnect mid-request) but is not
 * actually MCP-specific.
 */
describe('Context#error', () => {
  it('does not reject when nothing is listening for the error event', async () => {
    const ctx = new Context();
    expect(ctx.listenerCount('error')).toBe(0);

    await expect(ctx.error(new Error('aborted'))).resolves.toBeUndefined();
  });

  it('still runs cleanup (closes the context) with no error listener', async () => {
    const ctx = new Context();

    await ctx.error(new Error('aborted'));

    expect(ctx.isClosed).toBe(true);
  });

  it('still notifies a listener that IS attached (e.g. an open transaction)', async () => {
    const ctx = new Context();
    const seen: unknown[] = [];
    ctx.on('error', (err) => seen.push(err));

    const boom = new Error('boom');
    await ctx.error(boom);

    expect(seen).toEqual([boom]);
  });
});
