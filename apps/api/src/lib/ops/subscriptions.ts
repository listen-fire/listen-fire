import { getQb } from '../kysely';
import { PushSubscriptionId } from '../../generated/kysely/public/PushSubscription';

export type ActiveSubscription = {
  id: string; endpoint: string; p256dh: string; auth: string;
};

export async function loadActiveSubscriptions(): Promise<ActiveSubscription[]> {
  return getQb(['push_subscription'])
    .selectFrom('push_subscription')
    .select(['id', 'endpoint', 'p256dh', 'auth'])
    .execute();
}

export async function deleteSubscription(id: string): Promise<void> {
  await getQb(['push_subscription'])
    .deleteFrom('push_subscription')
    .where('id', '=', id as PushSubscriptionId)
    .execute();
}
