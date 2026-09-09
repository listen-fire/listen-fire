import { ModelService } from './utils';
import { findManyByFkDataloader, findByUniqueDataloader } from '../lib/datasources/dataloaders';
import { MAGIC_LINK_EXPIRY } from '../constants';
import { currentContext } from './context';

interface TokenCreateArgs {
  token: string;
  userId: string;
  expiry?: number;
}

class MagicLinkToken extends ModelService<'magicLinkToken'> {
  protected readonly objectName = 'magicLinkToken';

  dataloaders = this.getDataloaderGetters({
    findByEmail: findByUniqueDataloader('userEmail', 'email'),
    findManyByTeamId: findManyByFkDataloader('user', 'defaultTeamId'),
  });

  async create({ token, userId, expiry = MAGIC_LINK_EXPIRY }: TokenCreateArgs) {
    return this.model.create({
      data: {
        token,
        userId,
        expiresAt: new Date(Date.now() + expiry),
      },
    });
  }

  async getToken(token: string) {
    const data = await this.model.findUnique({
      where: {
        token,
        expiresAt: { gt: new Date() },
      },
    });

    return data;
  }

  async expireToken(id: string) {
    return this.model.update({
      where: { id },
      data: { expiresAt: new Date() },
    });
  }

  async findAllOwn() {
    const ctx = currentContext();

    return this.model.findMany({
      where: {
        userId: ctx.user.id,
        expiresAt: { gt: new Date() },
      },
    });
  }
}

const MagicLinkTokenService = new MagicLinkToken();

export { MagicLinkTokenService };
