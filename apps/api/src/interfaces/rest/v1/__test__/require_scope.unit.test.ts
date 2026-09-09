// The scope gate every /api/v1 product router mounts. It existed as six
// byte-identical copies, none of which expanded `'*'` — so the DEFAULT static
// configuration (`LISTEN_FIRE_SCOPES` unset) and core's own full-access keys were
// refused by every product API. The wildcard case below is the one that was
// broken; the rest pin what the copies already did.

import type { Response } from 'express';

import { requireScope } from '../require_scope';

function callGate(scopes: readonly string[] | undefined, required: string) {
  const json = jest.fn();
  const status = jest.fn(() => ({ json }));
  const next = jest.fn();
  const res = { locals: { apiKeyScopes: scopes }, status } as unknown as Response;

  requireScope(required)({} as never, res, next);

  return { passed: next.mock.calls.length === 1, status, json };
}

it('passes a key holding the exact scope', () => {
  expect(callGate(['asks'], 'asks').passed).toBe(true);
});

it('passes a key holding the wildcard — `*` grants everything', () => {
  expect(callGate(['*'], 'asks').passed).toBe(true);
  expect(callGate(['*'], 'valuations').passed).toBe(true);
});

it('passes when the wildcard sits among named scopes', () => {
  expect(callGate(['knowledge', '*'], 'automation').passed).toBe(true);
});

it('refuses a key holding only another product’s scope, naming what is missing', () => {
  const { passed, status, json } = callGate(['knowledge'], 'valuations');
  expect(passed).toBe(false);
  expect(status).toHaveBeenCalledWith(403);
  expect(json).toHaveBeenCalledWith({ error: 'API key missing required scope: valuations' });
});

it('refuses a principal carrying no scopes at all', () => {
  expect(callGate(undefined, 'asks').passed).toBe(false);
  expect(callGate([], 'asks').passed).toBe(false);
});
