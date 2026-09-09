// `signupFromVerifiedEmail` is the OAuth caller's side of the invite door: the
// door itself decides who gets in (covered against a real DB in
// `services/__test__/team_invite.integration.test.ts`), and this module decides
// what happens around a first sign-in — the attribution row, the "user created"
// event, the ops note — and what a refusal looks like to the REST handler.

const mockResolve = jest.fn();
jest.mock('../../team_invite', () => ({
  TeamInviteService: {
    resolveSignInForVerifiedEmail: (...a: unknown[]) => mockResolve(...a),
  },
}));

const mockRecordSignupEvent = jest.fn();
jest.mock('../attribution', () => ({
  recordSignupEvent: (...a: unknown[]) => mockRecordSignupEvent(...a),
}));

const mockGetById = jest.fn();
jest.mock('../../user', () => ({
  UserService: { getById: (...a: unknown[]) => mockGetById(...a) },
}));

const mockPublish = jest.fn();
jest.mock('../../../lib/message_queue', () => ({
  mq: { users: { created: { publish: (...a: unknown[]) => mockPublish(...a) } } },
}));

const mockSlack = jest.fn();
jest.mock('../../../lib/slack', () => ({
  sendSlackNotification: (...a: unknown[]) => mockSlack(...a),
}));

import { SignupService } from '../index';

beforeEach(() => {
  mockResolve.mockReset();
  mockRecordSignupEvent.mockReset().mockResolvedValue(undefined);
  mockGetById.mockReset().mockResolvedValue({ id: 'user-new', email: 'new@x.com' });
  mockPublish.mockReset();
  mockSlack.mockReset().mockResolvedValue(undefined);
});

test('an address nobody invited is refused, and nothing is recorded', async () => {
  mockResolve.mockResolvedValue({ status: 'not_invited' });

  const result = await SignupService.signupFromVerifiedEmail({ email: 'Stranger@X.com' });

  expect(result).toEqual({ ok: false, reason: 'not_invited' });
  expect(mockRecordSignupEvent).not.toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
});

test('a first sign-in records the channel, publishes the user, and tells ops', async () => {
  mockResolve.mockResolvedValue({
    status: 'ok',
    userId: 'user-new',
    teamId: 'team-1',
    email: 'new@x.com',
    created: true,
  });

  const result = await SignupService.signupFromVerifiedEmail({
    email: 'New@X.com',
    name: 'Nell',
    source: 'google',
  });

  expect(result).toEqual({ ok: true, email: 'new@x.com', created: true, teamId: 'team-1' });
  expect(mockResolve).toHaveBeenCalledWith({ email: 'New@X.com', name: 'Nell' });
  expect(mockRecordSignupEvent).toHaveBeenCalledWith(
    expect.objectContaining({ email: 'new@x.com', teamId: 'team-1', channel: 'google' }),
  );
  expect(mockPublish).toHaveBeenCalledTimes(1);
  expect(mockSlack).toHaveBeenCalledTimes(1);
});

test('a returning account is a plain sign-in — no attribution, no event, no ops note', async () => {
  mockResolve.mockResolvedValue({
    status: 'ok',
    userId: 'u1',
    teamId: 'team-existing',
    email: 'old@x.com',
    created: false,
  });

  const result = await SignupService.signupFromVerifiedEmail({ email: 'old@x.com' });

  expect(result).toEqual({ ok: true, email: 'old@x.com', created: false, teamId: 'team-existing' });
  expect(mockRecordSignupEvent).not.toHaveBeenCalled();
  expect(mockPublish).not.toHaveBeenCalled();
  expect(mockSlack).not.toHaveBeenCalled();
});
