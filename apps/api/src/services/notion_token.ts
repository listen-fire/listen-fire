import { ModelService } from './utils';

interface TokenCreateArgs {
  token: string;
  teamId: string;
}

class NotionToken extends ModelService<'notionToken'> {
  protected readonly objectName = 'notionToken';

  async create({ token, teamId }: TokenCreateArgs) {
    return this.model.create({
      data: {
        token,
        teamId,
      },
    });
  }

  async getByTeamId(teamId: string) {
    const token = await this.model.findFirst({
      where: {
        teamId,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return token;
  }
}

const NotionTokenService = new NotionToken();

export { NotionTokenService };
