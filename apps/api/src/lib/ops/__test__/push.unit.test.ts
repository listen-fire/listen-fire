// Set VAPID env vars before any module loads so ensureVapid() succeeds on first call
process.env.VAPID_PUBLIC_KEY = 'pub';
process.env.VAPID_PRIVATE_KEY = 'priv';
process.env.VAPID_SUBJECT = 'mailto:ops@example.com';

const sendNotification = jest.fn();
jest.mock('web-push', () => ({
  __esModule: true,
  default: { setVapidDetails: jest.fn(), sendNotification: (...a: any[]) => sendNotification(...a) },
}));

const deleteSubscription = jest.fn();
jest.mock('../subscriptions', () => ({
  loadActiveSubscriptions: async () => ([
    { id: 's1', endpoint: 'https://push/1', p256dh: 'k1', auth: 'a1' },
    { id: 's2', endpoint: 'https://push/2', p256dh: 'k2', auth: 'a2' },
  ]),
  deleteSubscription: (...a: any[]) => deleteSubscription(...a),
}));

import { sendToSubscriptions } from '../push';

describe('sendToSubscriptions', () => {
  beforeEach(() => {
    sendNotification.mockReset(); deleteSubscription.mockReset();
    process.env.VAPID_PUBLIC_KEY = 'pub'; process.env.VAPID_PRIVATE_KEY = 'priv';
    process.env.VAPID_SUBJECT = 'mailto:ops@example.com';
  });

  it('sends an (encrypted) notification to every subscription', async () => {
    sendNotification.mockResolvedValue({ statusCode: 201 });
    await sendToSubscriptions({ title: 't', body: 'b' }, 'evt-1');
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it('prunes a subscription the relay reports as gone (410)', async () => {
    sendNotification.mockResolvedValueOnce({ statusCode: 201 }).mockRejectedValueOnce({ statusCode: 410 });
    await sendToSubscriptions({ title: 't', body: 'b' }, 'evt-1');
    expect(deleteSubscription).toHaveBeenCalledWith('s2');
  });

  // The abuse contact a relay is given used to default to Listen-Fire's inbox, so a
  // deployment that is not Listen-Fire signed its notifications with our address.
  // With no subject configured the feature is off, not defaulted.
  it('stays off when VAPID_SUBJECT is unset', async () => {
    delete process.env.VAPID_SUBJECT;
    sendNotification.mockResolvedValue({ statusCode: 201 });
    let fresh: typeof import('../push') | undefined;
    jest.isolateModules(() => {
      fresh = require('../push');
    });
    await fresh!.sendToSubscriptions({ title: 't', body: 'b' }, 'evt-1');
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('does not throw on a transient relay error', async () => {
    sendNotification.mockRejectedValue({ statusCode: 500 });
    await expect(sendToSubscriptions({ title: 't', body: 'b' }, 'evt-1')).resolves.toBeUndefined();
    expect(deleteSubscription).not.toHaveBeenCalled();
  });
});
