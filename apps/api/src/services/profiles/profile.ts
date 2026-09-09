import { randomUUID } from 'node:crypto';

import * as db from '@prisma/client';

import { findByUniqueDataloader } from '../../lib/datasources/dataloaders';
import { ModelService } from '../utils';
import { getTeamSettings, repointTeamEntities } from '../../lib/valuations/team_settings';
import { currentContext } from '../context';
import { notNull } from '../../lib/utils/nullability';
import { mq } from '../../lib/message_queue';
import { retry } from '../../lib/utils/async';
import { extractCurrencyCodeOrThrow } from '../../lib/datasources/asset_transfer';
import { Money } from '../fx_conversion/money';
import { BANNED_SLUGS } from './bannedSlugs';

interface ProfileCreateArgs {
  id?: string;
  name: string;
  legalName?: string;
  type: db.LegalEntityType;
  city?: string | null;
  country?: string | null;
  slug?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  personalWebsite?: string | null;
  linkedin?: string | null;
  isPrivate?: boolean;
  publicProfileId?: string | null;
  themes?: string[];
  locations?: string[];
  stages?: string[];
  inferredThesis?: string | null;
  teamId?: string | null;
  identifiers?: string[];
  descriptorsGeo?: string[];
  descriptorsInvestorType?: string[];
  descriptorsStage?: string[];
  descriptorsMiscTags?: string[];
  summaryForSimilaritySearch?: string;
  marketShort?: string;
  linkedinData?: db.Prisma.InputJsonValue | db.Prisma.NullableJsonNullValueInput;
  pointOfContactUserId?: string | null;
  sentimentScore?: number;
  visibilityScore?: number;
}

interface ProfileUpdateArgs {
  name?: string;
  alsoKnownAs?: string;
  type?: db.LegalEntityType;
  city?: string | null;
  country?: string | null;
  imageUrl?: string | null;
  description?: string | null;
  personalWebsite?: string | null;
  linkedin?: string | null;
  publicProfileId?: string | null;
  themes?: string[];
  locations?: string[];
  stages?: string[];
  businessModel?: string[];
  markets?: string[];
  inferredThesis?: string | null;
  customers?: string[];
  investmentStatus?: db.InvestmentStatus;
  identifiers?: string[];
  descriptorsGeo?: string[];
  descriptorsInvestorType?: string[];
  descriptorsStage?: string[];
  descriptorsMiscTags?: string[];
  summaryForSimilaritySearch?: string | null;
  marketShort?: string;
  linkedinData?: db.Prisma.InputJsonValue | db.Prisma.NullableJsonNullValueInput;
  pointOfContactUserId?: string | null;
  sentimentScore?: number;
  visibilityScore?: number;
}

interface ProfileInvestmentCreateArgs {
  investorProfileId?: string | null;
  name?: string | null;
  legalName?: string | null;
  legalEntityType?: db.LegalEntityType | null;
  personalWebsite?: string | null | null;
  linkedin?: string | null | null;
  investmentProfileId: string;
  roundType?: db.EquityRoundType | null;
  date?: string | null;
}

class Profile extends ModelService<'legalEntity'> {
  protected readonly objectName = 'legalEntity';

  dataloaders = this.getDataloaderGetters({
    findBySlug: findByUniqueDataloader('legalEntity', 'slug'),
  });

  async create(args: ProfileCreateArgs) {
    const ctx = currentContext();
    let slugCandidate;
    if (args.publicProfileId) {
      slugCandidate = null;
    } else {
      slugCandidate = args.slug ?? args.name.trim().toLowerCase().replace(' ', '-');

      let existing;
      do {
        slugCandidate = `${slugCandidate}-${randomUUID().slice(0, 8)}`;
        existing = await this.findBySlug(slugCandidate);
      } while (existing);
    }

    const newProfile = await this.model.create({
      data: {
        id: args.id,
        name: args.name.trim(),
        legalName: args.legalName,
        type: args.type,
        city: args.city,
        country: args.country,
        imageUrl: args.imageUrl,
        description: args.description,
        personalWebsite: args.personalWebsite,
        linkedin: args.linkedin,
        slug: slugCandidate,
        isPublic: true,
        teamId: args.isPrivate ? ctx.user.teamId : undefined,
        publicProfileId: args.publicProfileId,
        themes: args.themes,
        locations: args.locations,
        stages: args.stages,
        inferredThesis: args.inferredThesis,
        descriptorsGeos: args.descriptorsGeo,
        descriptorsInvestorTypes: args.descriptorsInvestorType,
        descriptorsStages: args.descriptorsStage,
        descriptorsMiscTags: args.descriptorsMiscTags,
        summaryForSimilaritySearch: args.summaryForSimilaritySearch,
        marketShort: args.marketShort,
        pointOfContactUserId: args.pointOfContactUserId,
        sentimentScore: args.sentimentScore,
        visibilityScore: args.visibilityScore,
      },
    });

    ctx.onChangesCommitted(() => mq.profiles.created.publish(newProfile));
    this.dataloaders.findBySlug.clear(newProfile.slug);
    this.dataloaders.findById.clear(newProfile.id);

    return newProfile;
  }

  async update(id: string, args: ProfileUpdateArgs) {
    const profile = await this.model.update({
      where: {
        id,
      },
      data: {
        name: args.name,
        alsoKnownAs: args.alsoKnownAs,
        type: args.type,
        city: args.city,
        country: args.country,
        imageUrl: args.imageUrl,
        description: args.description,
        personalWebsite: args.personalWebsite,
        linkedin: args.linkedin,
        publicProfileId: args.publicProfileId,
        themes: args.themes,
        locations: args.locations,
        stages: args.stages,
        businessModels: args.businessModel,
        markets: args.markets,
        inferredThesis: args.inferredThesis,
        customers: args.customers,
        investmentStatus: args.investmentStatus,
        identifiers: args.identifiers,
        descriptorsGeos: args.descriptorsGeo,
        descriptorsInvestorTypes: args.descriptorsInvestorType,
        descriptorsStages: args.descriptorsStage,
        descriptorsMiscTags: args.descriptorsMiscTags,
        summaryForSimilaritySearch: args.summaryForSimilaritySearch,
        marketShort: args.marketShort,
        linkedinData: args.linkedinData,
        pointOfContactUserId: args.pointOfContactUserId,
        sentimentScore: args.sentimentScore,
        visibilityScore: args.visibilityScore,
      },
    });

    this.dataloaders.findById.clear(profile.id);
    this.dataloaders.findBySlug.clear(profile.slug);

    return profile;
  }

  async updateSlug(id: string, slug: string) {
    const existing = await this.findBySlug(slug);
    if (existing) {
      throw new Error('Slug already exists');
    }

    const profile = await this.model.update({
      where: {
        id,
      },
      data: {
        slug,
      },
    });

    this.dataloaders.findById.clear(profile.id);
    this.dataloaders.findBySlug.clear(profile.slug);

    return profile;
  }

  async findById(id: string) {
    return this.dataloaders.findById.load(id);
  }

  getFirstName(profile: Pick<db.LegalEntity, 'name'>) {
    return profile.name.split(' ')[0];
  }

  async findBySlug(slug: string) {
    return this.dataloaders.findBySlug.load(slug);
  }

  async getBySlug(slug: string) {
    const profile = await this.findBySlug(slug);
    if (!profile) {
      throw new Error('Could not find profile');
    } else {
      return profile;
    }
  }

  async isValidSlug(slug: string) {
    if (slug.trim().length < 4 || BANNED_SLUGS.includes(slug)) {
      return false;
    }
    return !(await this.findBySlug(slug));
  }

  // NOTE: this is really "publicProfileInvestments"
  async profileInvestments(id: string) {
    const ctx = currentContext();

    const investments = await ctx.prisma.investment.findMany({
      where: {
        teamId: ctx.user.teamId,
        OR: [
          { investorProfileId: id },
          {
            legalEntityInvestmentInvestorProfileIdTolegalEntity: {
              operatedByProfileId: id,
            },
          },
        ],
      },
      include: {
        legalEntityInvestmentInvestmentProfileIdTolegalEntity: true,
        legalEntityInvestmentInvestorProfileIdTolegalEntity: true,
      },
    });

    return investments
      .map((i) => {
        if (i.legalEntityInvestmentInvestmentProfileIdTolegalEntity == null) return null;
        return {
          id: i.id,
          roundType: i.roundType ?? db.EquityRoundType.UNKNOWN,
          company: i.legalEntityInvestmentInvestmentProfileIdTolegalEntity,
          date: i.investedAt,
        };
      })
      .filter(notNull);
  }

  async publicProfileInvestments(id: string) {
    const ctx = currentContext();

    const investments = await ctx.prisma.investment.findMany({
      where: {
        investorProfileId: id,
        teamId: null,
      },
      include: {
        legalEntityInvestmentInvestmentProfileIdTolegalEntity: true,
      },
      orderBy: {
        investedAt: 'asc',
      },
    });
    return investments
      .map((i) => {
        if (i.legalEntityInvestmentInvestmentProfileIdTolegalEntity == null) return null;
        return {
          id: i.id,
          roundType: i.roundType ?? db.EquityRoundType.UNKNOWN,
          company: i.legalEntityInvestmentInvestmentProfileIdTolegalEntity,
          date: i.investedAt,
        };
      })
      .filter(notNull);
  }

  async profileInvestors(id: string) {
    const ctx = currentContext();
    const { ownEntityId } = await getTeamSettings(ctx.user.teamId);

    const investors = await ctx.prisma.investment.findMany({
      where: {
        teamId: ctx.user.teamId,
        investmentProfileId: id,
        AND: ownEntityId
          ? [
              {
                legalEntityInvestmentInvestorProfileIdTolegalEntity: {
                  id: { not: ownEntityId },
                  OR: [
                    {
                      operatedByProfileId: { not: ownEntityId },
                    },
                    {
                      operatedByProfileId: null,
                    },
                  ],
                },
              },
            ]
          : undefined,
      },

      include: {
        legalEntityInvestmentInvestorProfileIdTolegalEntity: true,
      },
    });

    return investors
      .map((i) => {
        if (i.legalEntityInvestmentInvestorProfileIdTolegalEntity == null) return null;
        return {
          id: i.id,
          roundType: i.roundType ?? db.EquityRoundType.UNKNOWN,
          investor: i.legalEntityInvestmentInvestorProfileIdTolegalEntity,
          date: i.investedAt,
        };
      })
      .filter(notNull);
  }

  async getOrCreateByWebsite(args: ProfileCreateArgs) {
    return retry(async () => {
      const existing = await this.model.findFirst({
        where: {
          personalWebsite: args.personalWebsite,
          teamId: currentContext().user.teamId,
        },
      });

      if (existing) {
        return existing;
      }

      return this.create(args);
    });
  }

  async findManyMatchingByIdentifier(identifiers: string[], type: 'COMPANY' | 'NATURAL_PERSON') {
    return this.model.findMany({
      where: {
        identifiers: {
          hasSome: identifiers,
        },
        type,
        teamId: currentContext().user.teamId,
      },
    });
  }

  async searchByFullname(fullname: string) {
    return this.model.findMany({
      where: {
        name: {
          contains: fullname,
          mode: 'insensitive',
        },
      },
      take: 50,
    });
  }

  async searchFundByExactName(fullname: string) {
    return this.model.findMany({
      where: {
        name: {
          equals: fullname,
          mode: 'insensitive',
        },
        type: 'FUND',
        teamId: null,
      },
      take: 50,
    });
  }

  async findByWebsite(
    website: string,
    type: 'COMPANY' | 'NATURAL_PERSON',
    { isPrivate }: { isPrivate?: boolean } = {},
  ) {
    const ctx = currentContext();

    return this.model.findFirst({
      where: {
        OR: [{ personalWebsite: website }, { linkedin: website }],
        type:
          type === 'COMPANY' ? { in: ['COMPANY', 'PORTFOLIO_COMPANY', 'FUND'] } : 'NATURAL_PERSON',
        teamId: isPrivate === false ? null : isPrivate === true ? ctx.user.teamId : undefined,
      },
    });
  }

  async getPrivateProfiles(id: string) {
    const ctx = currentContext();

    return this.model.findMany({
      where: {
        publicProfileId: id,
        teamId: ctx.user.teamId,
      },
    });
  }

  async getInvestingEntities(id: string, teamId?: string) {
    const ctx = currentContext();

    const funds = await ctx.prisma.investment.findMany({
      where: {
        teamId: teamId ?? ctx.user.teamId,
        investmentProfileId: id,
        legalEntityInvestmentInvestorProfileIdTolegalEntity: {
          isPortfolio: true,
          isDeprecated: false,
        },
      },
      distinct: ['investorProfileId'],
      select: {
        legalEntityInvestmentInvestorProfileIdTolegalEntity: true,
      },
    });

    return funds.map((i) => i.legalEntityInvestmentInvestorProfileIdTolegalEntity).filter(notNull);
  }

  async getTotalAmountInvested(id: string, eventId?: string, asOfDate?: Date, teamId?: string) {
    const ctx = currentContext();

    const funds = (await this.getInvestingEntities(id, teamId)).map((i) => i.id).filter(notNull);
    const legalEntity = await ctx.prisma.legalEntity.findUnique({
      where: {
        id: id,
        teamId: teamId ?? ctx.user.teamId,
      },
      select: {
        id: true,
        teamId: true,
        name: true,
        legalName: true,
      },
    });
    if (!legalEntity) {
      return 0;
    }
    const trx = await ctx.prisma.assetTransfer.findMany({
      where: {
        teamId: teamId ?? ctx.user.teamId,
        toLegalEntityId: legalEntity.id,
        fromLegalEntityId: { in: funds },
        asset: {
          type: 'CURRENCY',
        },
        transaction: {
          eventId: eventId,
        },
      },
      include: {
        asset: {
          include: {
            currencyAsset: true,
          },
        },
      },
    });
    const total = await trx.reduce(async (acc, t) => {
      if (!t.numAssets) return acc;
      const currency = extractCurrencyCodeOrThrow(t);
      const money = await new Money({
        currency,
        amount: t.numAssets,
      }).fxConvert({
        toCurrency: db.CurrencyIsoCode.USD,
        date: asOfDate ?? t.date,
      });

      return (await acc) + money.amount;
    }, Promise.resolve(0));
    return total;
  }

  async getLatestRoundWithValuation(id: string, options?: { targetCurrency?: db.CurrencyIsoCode; fxDate?: Date }) {
    const ctx = currentContext();
    const legalEntity = await ctx.prisma.legalEntity.findUnique({
      where: {
        id: id,
        teamId: ctx.user.teamId,
      },
      select: {
        id: true,
        teamId: true,
        name: true,
        legalName: true,
      },
    });

    if (!legalEntity) {
      return null;
    }
    const round = await ctx.prisma.event.findFirst({
      orderBy: {
        date: 'desc',
      },
      where: {
        teamId: ctx.user.teamId,
        legalEntityId: legalEntity.id,
        type: db.EventType.INVESTMENT_ROUND,
      },
    });
    let money;
    const toCurrency = options?.targetCurrency ?? db.CurrencyIsoCode.USD;
    const fxDate = options?.fxDate ?? new Date();
    if (round?.assetType === db.AssetType.EQUITY && round?.valuation && round?.valuationCurrency) {
      money = new Money({
        amount: round?.valuation,
        currency: round.valuationCurrency,
      }).fxConvert({
        toCurrency,
        date: fxDate,
      });
    } else if (round?.assetType === db.AssetType.CONVERTIBLE) {
      const convertible = await ctx.prisma.asset.findFirst({
        where: {
          teamId: ctx.user.teamId,
          type: db.AssetType.CONVERTIBLE,
          issuedByLegalEntityId: legalEntity.id,
        },
      });
      if (convertible && convertible.valuationCap && convertible.convertibleCurrency) {
        money = new Money({
          amount: convertible.valuationCap,
          currency: convertible.convertibleCurrency,
        }).fxConvert({
          toCurrency,
          date: fxDate,
        });
      }
    }

    return {
      date: round?.date,
      roundType: round?.roundType,
      isConvertible: round?.investmentRoundType === db.InvestmentRoundType.CONVERTIBLE,
      valuation: {
        valuationType: round?.valuationType,
        value: money ? (await money).amount : null,
      },
    };
  }

  async getTotalValue(id: string, teamId?: string) {
    const ctx = currentContext();

    const funds = (await this.getInvestingEntities(id, teamId)).map((i) => i.id).filter(notNull);
    const legalEntity = await ctx.prisma.legalEntity.findUnique({
      where: {
        id: id,
        teamId: teamId ?? ctx.user.teamId,
      },
      select: {
        id: true,
        teamId: true,
        name: true,
        legalName: true,
      },
    });

    if (!legalEntity) {
      return null;
    }

    const latestPrice = await ctx.prisma.price.findFirst({
      orderBy: {
        date: 'desc',
      },
      where: {
        teamId: teamId ?? ctx.user.teamId,
        legalEntityId: legalEntity.id,
      },
      select: {
        price: true,
        currency: true,
      },
    });

    const trx = await ctx.prisma.assetTransfer.findMany({
      where: {
        teamId: teamId ?? ctx.user.teamId,
        fromLegalEntityId: legalEntity.id,
        toLegalEntityId: { in: funds },
        transaction: {
          convertedToId: null,
        },
      },
      include: {
        asset: {
          include: {
            currencyAsset: true,
            prices: {
              orderBy: {
                date: 'desc',
              },
              take: 1,
            },
          },
        },
      },
    });
    const total = await trx.reduce(async (acc, t) => {
      if (!t.numAssets) return acc;
      // If the asset is a convertible, it means it hasn't been converted yet.
      // We use the price of the convertible asset to calculate the total value
      // or return the invested amount.
      if (
        t.asset.type === db.AssetType.CONVERTIBLE &&
        t.asset.convertibleAmount &&
        t.asset.convertibleCurrency
      ) {
        const price =
          t.asset.prices.length === 1 ? t.asset.prices[0].price : t.asset.convertibleAmount;
        const money = await new Money({
          amount: price,
          currency: t.asset.convertibleCurrency,
        }).fxConvert({
          toCurrency: db.CurrencyIsoCode.USD,
          date: new Date(),
        });
        return (await acc) + money.amount;
      } else if (t.asset.type === db.AssetType.CURRENCY && t.asset.currencyAsset) {
        const money = await new Money({
          amount: t.numAssets,
          currency: t.asset.currencyAsset.isoCode,
        }).fxConvert({
          toCurrency: db.CurrencyIsoCode.USD,
          date: t.date,
        });
        return (await acc) + money.amount;
      } else if (latestPrice) {
        const money = await new Money({
          amount: latestPrice.price * t.numAssets,
          currency: latestPrice.currency,
        }).fxConvert({
          toCurrency: db.CurrencyIsoCode.USD,
          date: new Date(),
        });
        return (await acc) + money.amount;
      } else {
        return this.getTotalAmountInvested(id);
      }
    }, Promise.resolve(0));
    return total;
  }

  async addProfileInvestment(args: ProfileInvestmentCreateArgs) {
    const ctx = currentContext();

    let investorProfileId = null;
    if (!args.investorProfileId) {
      if (!args.name || !args.legalEntityType) {
        throw new Error('Missing investor profile name');
      }
      investorProfileId = (
        await this.create({
          name: args.name,
          type: args.legalEntityType,
          linkedin: args.linkedin,
          personalWebsite: args.personalWebsite,
          isPrivate: true,
        })
      ).id;
    } else {
      const profile = await this.model.findUnique({
        where: {
          id: args.investorProfileId,
        },
      });

      if (!profile) {
        throw new Error('Investor profile not found');
      }
      investorProfileId = profile.id;
    }

    const investmentProfile = await ctx.prisma.legalEntity.findUnique({
      where: {
        id: args.investmentProfileId,
      },
    });

    if (!investmentProfile) {
      throw new Error('Investment profile not found');
    }

    const investment = await ctx.prisma.investment.create({
      data: {
        teamId: ctx.user.teamId,
        investorProfileId: investorProfileId,
        investmentProfileId: args.investmentProfileId,
        roundType: args.roundType ?? db.EquityRoundType.UNKNOWN,
        investedAt: args.date ? new Date(args.date) : new Date(),
      },
    });

    return investment;
  }

  async linkTeamMemberToCompany(teamMemberId: string, companyId: string, description: string) {
    const ctx = currentContext();

    const existing = await ctx.prisma.profileRole.findFirst({
      where: {
        profileId: teamMemberId,
        entityId: companyId,
      },
    });

    if (existing) {
      return existing;
    }

    return ctx.prisma.profileRole.create({
      data: {
        profileId: teamMemberId,
        entityId: companyId,
        description,
      },
    });
  }
}

const ProfileService = new Profile();

export { ProfileService };
