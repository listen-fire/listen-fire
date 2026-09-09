import { currentContext } from '../context';
import { ModelService } from '../utils';

class ProfileEmail extends ModelService<'profileEmail'> {
  protected readonly objectName = 'profileEmail';

  async create({
    profileId,
    email,
    isPrivate,
  }: {
    profileId: string;
    email: string;
    isPrivate?: boolean;
  }) {
    const ctx = currentContext();

    const created = await this.model.create({
      data: {
        profileId: profileId,
        email,
        teamId: isPrivate ? ctx.user.teamId : null,
      },
    });

    return created;
  }

  async findByEmail(email: string, { isPrivate }: { isPrivate?: boolean } = {}) {
    const ctx = currentContext();

    return this.model.findFirst({
      where: {
        email,
        teamId: isPrivate ? ctx.user.teamId : null,
      },
    });
  }

  async findManyByProfileId(profileId: string) {
    return this.model.findMany({
      where: {
        profileId,
      },
    });
  }
}

const ProfileEmailService = new ProfileEmail();

export { ProfileEmailService };
