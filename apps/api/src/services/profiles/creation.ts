import * as db from '@prisma/client';

import { ProfileService } from './profile';
import { ProfileEmailService } from './email';
import { retry } from '../../lib/utils/async';

async function getOrCreateProfileByEmail({
  email,
  name,
  linkedin,
  isPrivate,
}: {
  email: string;
  name: string;
  linkedin?: string | null;
  isPrivate?: boolean;
}) {
  return retry(async () => {
    const existingProfileEmail = await ProfileEmailService.findByEmail(email, { isPrivate });

    if (existingProfileEmail) {
      return ProfileService.getById(existingProfileEmail.profileId);
    }

    let profile;
    if (linkedin) {
      profile = await getOrCreateProfileByLinkedIn({ name, linkedin, isPrivate });
    } else {
      const existingPublicProfileEmail = await ProfileEmailService.findByEmail(email, {
        isPrivate: false,
      });

      profile = await ProfileService.create({
        name: name,
        type: db.LegalEntityType.NATURAL_PERSON,
        isPrivate,
        publicProfileId: isPrivate ? existingPublicProfileEmail?.profileId : null,
      });
    }

    await ProfileEmailService.create({
      profileId: profile.id,
      email,
      isPrivate,
    });

    return profile;
  });
}

async function getOrCreateProfileByLinkedIn({
  name,
  linkedin,
  isPrivate,
}: {
  name: string;
  linkedin: string;
  isPrivate?: boolean;
}) {
  const existingProfile = await ProfileService.findByWebsite(linkedin, 'NATURAL_PERSON', {
    isPrivate,
  });

  if (existingProfile) {
    return existingProfile;
  }

  const existingPublicProfile = await ProfileService.findByWebsite(linkedin, 'NATURAL_PERSON', {
    isPrivate: false,
  });

  return ProfileService.create({
    name: name,
    type: db.LegalEntityType.NATURAL_PERSON,
    linkedin,
    isPrivate,
    publicProfileId: isPrivate ? existingPublicProfile?.id : null,
  });
}

export { getOrCreateProfileByEmail };
