// The two push doors a module calls when it owns its own inbound URL:
//
//   POST …/<adapterType>/emit                retired in 0.13: refused 410 once
//                                            authenticated (an event fires no
//                                            listen)
//   POST …/<adapterType>/wake  { arrivals }  what landed on listenable edges
//                                            (adapter protocol 2.5), kept as
//                                            a delivery is: logged, waking the
//                                            waits parked on each record, with
//                                            the runs it starts
//
// The caller presents the credential its install holds and the install whose
// secret matches is the team (the store decides). A wake answers 202
// `{ accepted }` once the arrivals are logged; an emit answers 410; a wake that
// names `keys` (before 2.5) is a 400 naming `arrivals`; 401 with no detail when the
// credential matches no install, so the door says nothing about who installed
// what; 409 when it matches installs on several teams and none is named; 400
// for a malformed body, judged only after authentication.
//
// Beside them, the models door a module served as a process asks for model
// calls through (module kit `hostModels`), authenticated the same way:
//
//   POST …/<adapterType>/models  HostModelRequest  →  200 HostModelAnswer
//
// The host answers through its models; the door bills no run itself. The
// answer's `cost` rides back on the response of the call whose work asked,
// so the run that made that call is charged.

import { AdapterWakeBody, HostModelRequest, type Arrival, type HostModelAnswerShape, type HostModelRequestShape } from 'engine-contracts';
import type { z } from 'zod';

import type { InboundAnswer } from './deliver';
import type { InboundHeaders } from './verify';

import { logger } from '../logger';
import { ADAPTER_TEAM_HEADER } from '../translation_graph/protocol/client';
import { neverAsAny } from '../../lib/utils/types';

/** The install a push authenticated as. */
export interface PushCaller {
  teamId: string;
  adapterType: string;
  credentialsId: string;
}

export type PushAuth =
  | { kind: 'authenticated'; caller: PushCaller }
  | { kind: 'unauthorized' }
  | { kind: 'ambiguous' };

export interface PushStore {
  authenticate(input: { adapterType: string; headers: InboundHeaders }): Promise<PushAuth>;
  /** Keep what arrived on the caller's listenable edges in one write, as
   *  `InboundStore.keepDelivery` keeps a delivery's arrivals: logged, waking
   *  the waits parked on each record, with each run an arrival starts
   *  queued and its trigger's waits opened from the mark before them. */
  keepArrivals(input: { adapterType: string; teamId: string; arrivals: readonly Arrival[] }): Promise<void>;
  notify(): void;
}

const EMIT_RETIRED =
  '`emit` is retired in listen-fire 0.13: a listen is a traversal, fired by the arrivals on its edge, so an event fires no listen; send what happened to `wake` as `arrivals` (docs/contracts/adapter-protocol.md, Reporting arrivals)';

export interface PushRequest {
  adapterType: string;
  headers: InboundHeaders;
  /** The parsed JSON body. */
  body: unknown;
}

async function callerOf(store: PushStore, request: PushRequest): Promise<PushCaller | InboundAnswer> {
  const auth = await store.authenticate({ adapterType: request.adapterType, headers: request.headers });
  switch (auth.kind) {
    case 'authenticated':
      return auth.caller;
    case 'unauthorized':
      return { status: 401, body: { error: 'unauthorized' } };
    case 'ambiguous':
      return {
        status: 409,
        body: {
          error: 'ambiguous_credential',
          message: `this credential belongs to more than one team's install; name the team in the ${ADAPTER_TEAM_HEADER} header`,
        },
      };
    default:
      return neverAsAny(auth);
  }
}

function badRequest(error: z.ZodError): InboundAnswer {
  return {
    status: 400,
    body: {
      error: 'bad_request',
      issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    },
  };
}

/** Keep what arrived. An arrival no live wait reads stays logged until a
 *  sweep passes it (`sweepArrivals`); `accepted` counts them. */
export async function keepArrivals(
  store: PushStore,
  input: { caller: PushCaller; arrivals: readonly Arrival[] },
): Promise<{ accepted: number }> {
  await store.keepArrivals({ adapterType: input.caller.adapterType, teamId: input.caller.teamId, arrivals: input.arrivals });
  store.notify();
  return { accepted: input.arrivals.length };
}

/** Authenticated like every push, then refused by name: from 0.13 an event
 *  fires no listen, so a door that kept it would accept and do nothing. */
export async function answerEmit(store: PushStore, request: PushRequest): Promise<InboundAnswer> {
  try {
    const caller = await callerOf(store, request);
    if ('status' in caller) return caller;
    return { status: 410, body: { error: 'emit_retired', message: EMIT_RETIRED } };
  } catch (err) {
    logger.error('[AdapterDoors] emit failed', { err });
    return { status: 500, body: { error: 'internal' } };
  }
}

export async function answerWake(store: PushStore, request: PushRequest): Promise<InboundAnswer> {
  try {
    const body = AdapterWakeBody.safeParse(request.body);
    const caller = await callerOf(store, request);
    if ('status' in caller) return caller;
    if (!body.success) return badRequest(body.error);
    return { status: 202, body: await keepArrivals(store, { caller, arrivals: body.data.arrivals }) };
  } catch (err) {
    logger.error('[AdapterDoors] wake failed', { err });
    return { status: 500, body: { error: 'internal' } };
  }
}

/** How a host answers its models door: one model call for the install that asked. */
export type HostModelCall = (input: { caller: PushCaller; request: HostModelRequestShape }) => Promise<HostModelAnswerShape>;

/** A request the host's models refuse as asked (a model it does not know, a
 *  schema a forced tool cannot carry): answered 400 with its message. */
export class HostModelRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostModelRefused';
  }
}

export async function answerModels(store: PushStore, request: PushRequest, models: HostModelCall): Promise<InboundAnswer> {
  try {
    const body = HostModelRequest.safeParse(request.body);
    const caller = await callerOf(store, request);
    if ('status' in caller) return caller;
    if (!body.success) return badRequest(body.error);
    return { status: 200, body: await models({ caller, request: body.data }) };
  } catch (err) {
    if (err instanceof HostModelRefused) return { status: 400, body: { error: 'bad_request', message: err.message } };
    logger.error('[AdapterDoors] model call failed', { err });
    return { status: 502, body: { error: 'model_call_failed', message: err instanceof Error ? err.message : String(err) } };
  }
}

