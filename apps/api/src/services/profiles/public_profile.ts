import { getCoreQb, getValuationsQb } from '../../lib/kysely';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { UserId } from '../../generated/kysely/core/User';
import { notNull } from '../../lib/utils/nullability';

type PublicProfile = {
  id: LegalEntityId;
  name: string;
  imageUrl: string | null;
  slug: string | null;
};

/**
 * `user.public_profile_id` names a `valuations.legal_entity` row across the
 * schema boundary, so prisma no longer offers the traversal (D3 dropped the
 * FK). The column itself is dealflow-era and D6 removes it with core's Phase 4
 * work — until then the surfaces that render a user's public profile resolve it
 * with a second read.
 */
async function publicProfilesByUserId(userIds: string[]): Promise<Map<string, PublicProfile>> {
  if (!userIds.length) return new Map();

  const users = await getCoreQb(['user'])
    .selectFrom('user')
    .select(['id', 'public_profile_id'])
    .where('id', 'in', userIds as UserId[])
    .where('public_profile_id', 'is not', null)
    .execute();

  const profileIds = users.map((u) => u.public_profile_id).filter(notNull);
  if (!profileIds.length) return new Map();

  const profiles = await getValuationsQb(['legal_entity'])
    .selectFrom('legal_entity')
    .select(['id', 'name', 'image_url', 'slug'])
    .where('id', 'in', profileIds as LegalEntityId[])
    .execute();

  const byProfileId = new Map(
    profiles.map((p) => [
      p.id as string,
      { id: p.id, name: p.name, imageUrl: p.image_url, slug: p.slug },
    ]),
  );

  return new Map(
    users
      .map((u) => {
        const profile = u.public_profile_id && byProfileId.get(u.public_profile_id);
        return profile ? ([u.id as string, profile] as const) : null;
      })
      .filter(notNull),
  );
}

async function publicProfileForUser(userId: string): Promise<PublicProfile | null> {
  return (await publicProfilesByUserId([userId])).get(userId) ?? null;
}

export { publicProfilesByUserId, publicProfileForUser };
export type { PublicProfile };
