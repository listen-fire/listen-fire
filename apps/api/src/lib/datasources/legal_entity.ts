import { DataContext } from '.';

import * as db from '@prisma/client';

import { ProfileService } from '../../services/profiles/profile';
import { companyTerms } from '../ner/nomalize';
import { Dataloaders as AllDataloaders } from './dataloaders';

interface LegalEntitySearchInput {
  portfolioId?: string;
  searchName?: string; // if omitted, then return all entities
  matchWholeName?: boolean; // false by default
  legalEntityType?: db.LegalEntityType;
}

class LegalEntity {
  constructor(private readonly ctx: DataContext<AllDataloaders>) {}

  public async create({
    legalName,
    type,
  }: {
    legalName: string;
    type: db.LegalEntityType;
  }): Promise<db.LegalEntity> {
    const legalEntity = await ProfileService.create({
      name: legalName,
      legalName: legalName,
      type: type,
      isPrivate: true,
    });

    return legalEntity;
  }

  public async getById(id: string): Promise<db.LegalEntity> {
    const entity = await this.ctx.dataloaders.legalEntityById.load(id);
    if (entity === null) {
      throw new Error(`Could not find legal entity ${id}`);
    }
    return entity;
  }

  public async getByName(input: LegalEntitySearchInput): Promise<db.LegalEntity> {
    const entities = await this.findByName(input);

    if (entities.length === 1) {
      return entities[0];
    } else if (entities.length > 1) {
      throw new Error(
        `Found multiple legal entities with search criteria ${JSON.stringify(input)}`,
      );
    } else {
      throw new Error(
        `Could not find any legal entity with search criteria ${JSON.stringify(input)}`,
      );
    }
  }

  public async getByNameOrCreate({
    legalName,
    type,
  }: {
    legalName: string;
    type?: db.LegalEntityType;
  }): Promise<db.LegalEntity> {
    try {
      return await this.getByName({
        searchName: legalName,
        matchWholeName: true,
      });
    } catch {
      return type
        ? await this.create({ legalName, type })
        : await this.create({ legalName, type: LegalEntity.inferLegalEntityType(legalName) });
    }
  }

  public async findByName(input: LegalEntitySearchInput): Promise<db.LegalEntity[]> {
    return this.ctx.prisma.legalEntity.findMany({
      where: {
        ...LegalEntity.companyNameFilter(input.searchName, input.matchWholeName),
        type: input.legalEntityType,
        teamId: this.ctx.teamId,
      },
      ...LegalEntity.takeLimit(),
    });
  }

  public async markAsPortfolio(portfolio: db.LegalEntity): Promise<void> {
    await this.ctx.prisma.legalEntity.update({
      where: {
        id: portfolio.id,
      },
      data: {
        isPortfolio: true,
      },
    });
    portfolio.isPortfolio = true;
  }

  static companyNameFilter(searchName?: string, matchWholeName = false) {
    if (!searchName || !searchName.trim()) {
      return {};
    }

    const trimmedName = searchName.trim();
    const searchFilter: db.Prisma.StringFilter = matchWholeName
      ? { equals: trimmedName, mode: 'insensitive' }
      : { contains: trimmedName, mode: 'insensitive' };

    return {
      OR: [{ name: searchFilter }, { legalName: searchFilter }],
    };
  }

  static takeLimit(limit = 100) {
    return { take: limit };
  }

  static inferLegalEntityType(name: string) {
    const cleanName = name.toLowerCase().trim();
    const hasCompanyTerm = (s: string) => [...companyTerms].some((term) => s.includes(` ${term}$`));
    const hasFundTerm = (s: string) => s.includes(' fund');
    const hasSpvTerm = (s: string) =>
      ['spv', 'a series of', 'syndicate'].some((term) => s.includes(term));

    if (hasSpvTerm(cleanName)) {
      return db.LegalEntityType.SPV;
    } else if (hasFundTerm(cleanName)) {
      return db.LegalEntityType.FUND;
    } else if (hasCompanyTerm(cleanName) || cleanName.split(' ').length === 1) {
      return db.LegalEntityType.COMPANY;
    }

    return db.LegalEntityType.NATURAL_PERSON;
  }
}

export { LegalEntity };
