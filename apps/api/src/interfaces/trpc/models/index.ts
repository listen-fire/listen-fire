import { trpc } from '../trpc';
import { userProcedure } from '../procedures';
import { userRouter } from './user';

// `models.user.*` reads the acting identity, so it takes the protected
// procedure like every other router. It used to be handed the RAW builder,
// which meant `authorise()` never ran: invisible over HTTP (express has already
// authenticated) but a 500 "Missing user" over the websocket, for a valid
// token. Wrapping it is the fix, and it turns an unauthenticated call into an
// UNAUTHORIZED rather than a crash.
const modelsRouter = trpc.router({
  user: userRouter(userProcedure(trpc.procedure)),
});

export { modelsRouter };
