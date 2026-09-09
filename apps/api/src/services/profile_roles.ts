import { findManyByFkDataloader } from '../lib/datasources/dataloaders';
import { ModelService } from './utils';

interface ProfileRoleCreateArgs {
  profileId: string;
  description: string;
  entityId?: string | null;
}
class ProfileRole extends ModelService<'profileRole'> {
  protected readonly objectName = 'profileRole';

  dataloaders = this.getDataloaderGetters({
    findManyByProfileId: findManyByFkDataloader('profileRole', 'profileId'),
  });

  async create(args: ProfileRoleCreateArgs) {
    return this.model.create({
      data: args,
    });
  }

  async findManyByProfileId(id: string) {
    return this.dataloaders.findManyByProfileId.load(id);
  }

  async remove(id: string) {
    return this.model.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}

const ProfileRoleService = new ProfileRole();

export { ProfileRoleService };
