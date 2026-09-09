import * as db from '@prisma/client';
import DataLoader from 'dataloader';
import memoize from 'lodash/memoize';

import { hash } from '../../utils/hash';
import { getAssetByIdDataloader } from '../asset';
import {
  getPricesByIssuerIdDataloader,
  getLatestPricesByIssuerAssetTypeAndDateDataloader,
  getLatestPriceByAssetIdAndDateDataloader,
} from '../price';
import { getNotesByReferenceIdAndTypeDataloader } from '../note';
import { getEventByTransactionIdDataloader, getEventWithTransfersByIdDataloader } from '../event';
import { getTransactionByIdDataloader } from '../transaction';
import { getDistributionByLegalEntityIdDataloader } from '../distribution';
import { getDividendByLegalEntityIdDataloader } from '../dividend';
import { getExchangeRateByFromToDateDataloader } from '../exchange_rate';
import { getPortfolioCompanyMetricByCompanyAndInvestorIdDataloader } from '../portfolio_company_metric';
import { currentContext, unsafeCurrentContext } from '../../../services/context';
import {
  getDataloaders as getCurrencyDataloaders,
  Dataloaders as CurrencyDataloaders,
} from './currency';
import {
  getDataloaders as getLegalEntityDataloaders,
  Dataloaders as LegalEntityDataloaders,
} from './legal_entity';
import { getDataloaders as getUserDataloaders, Dataloaders as UserDataloaders } from './user';

// ensure that when the context is cleaned up, all dataloaders are cleared
memoize.Cache = WeakMap;

// Cache a dataloader for the current context.
// If the current context changes, the dataloader will be re-created.
// If the current context is undefined, the dataloader will be re-created every time it's used.
const memo = <T extends () => DataLoader<unknown, unknown>>(fn: T) =>
  memoize<T>(fn, () => unsafeCurrentContext() ?? {});

const defaultOptions = {
  batchScheduleFn:
    (process.env.NODE_ENV as string) === 'staging' || process.env.NODE_ENV === 'production'
      ? (callback: () => void) => setTimeout(callback, 50)
      : undefined,
  cacheKeyFn: <K extends Record<keyof K, unknown>>(key: K): string =>
    typeof key === 'string' ? key : hash<K>(key),
};

interface Dataloaders extends CurrencyDataloaders, LegalEntityDataloaders, UserDataloaders {
  assetById: ReturnType<typeof getAssetByIdDataloader>;
  distributionByLegalEntityId: ReturnType<typeof getDistributionByLegalEntityIdDataloader>;
  dividendByLegalEntityId: ReturnType<typeof getDividendByLegalEntityIdDataloader>;
  eventByTransactionId: ReturnType<typeof getEventByTransactionIdDataloader>;
  eventWithTransfersById: ReturnType<typeof getEventWithTransfersByIdDataloader>;
  exchangeRateByFromToDate: ReturnType<typeof getExchangeRateByFromToDateDataloader>;
  latestPriceByAssetIdAndDate: ReturnType<typeof getLatestPriceByAssetIdAndDateDataloader>;
  latestPricesByIssuerAssetTypeAndDate: ReturnType<
    typeof getLatestPricesByIssuerAssetTypeAndDateDataloader
  >;
  notesByReferenceIdAndType: ReturnType<typeof getNotesByReferenceIdAndTypeDataloader>;
  portfolioCompanyMetricByCompanyAndInvestorId: ReturnType<
    typeof getPortfolioCompanyMetricByCompanyAndInvestorIdDataloader
  >;
  pricesByIssuerId: ReturnType<typeof getPricesByIssuerIdDataloader>;
  transactionById: ReturnType<typeof getTransactionByIdDataloader>;
}

function getDataloaders(prisma: db.Prisma.TransactionClient): Dataloaders {
  return {
    assetById: getAssetByIdDataloader(prisma, defaultOptions),
    distributionByLegalEntityId: getDistributionByLegalEntityIdDataloader(prisma, defaultOptions),
    dividendByLegalEntityId: getDividendByLegalEntityIdDataloader(prisma, defaultOptions),
    eventByTransactionId: getEventByTransactionIdDataloader(prisma, defaultOptions),
    eventWithTransfersById: getEventWithTransfersByIdDataloader(prisma, defaultOptions),
    exchangeRateByFromToDate: getExchangeRateByFromToDateDataloader(prisma, defaultOptions),
    latestPriceByAssetIdAndDate: getLatestPriceByAssetIdAndDateDataloader(prisma, defaultOptions),
    latestPricesByIssuerAssetTypeAndDate: getLatestPricesByIssuerAssetTypeAndDateDataloader(
      prisma,
      defaultOptions,
    ),
    notesByReferenceIdAndType: getNotesByReferenceIdAndTypeDataloader(prisma, defaultOptions),
    portfolioCompanyMetricByCompanyAndInvestorId:
      getPortfolioCompanyMetricByCompanyAndInvestorIdDataloader(prisma, defaultOptions),
    pricesByIssuerId: getPricesByIssuerIdDataloader(prisma, defaultOptions),
    transactionById: getTransactionByIdDataloader(prisma, defaultOptions),
    ...getCurrencyDataloaders(prisma),
    ...getLegalEntityDataloaders(prisma),
    ...getUserDataloaders(prisma),
  };
}

// Mapping functions for dataloader output from prisma results

/**
 * given keys[] passed to a prisma `in` filter,
 * return the loaded data in order of the corresponding keys,
 * overwriting duplicate results
 * efficient version of `keys.map(key => loadedData.find(item => item[keyName] === key))`
 */
const mapToScalar = <T, U extends keyof T>(
  keys: readonly T[U][],
  loadedData: T[],
  keyName: U,
  options: { caseInsensitive?: boolean } = {},
) => {
  const normalise = options.caseInsensitive
    ? (key: T[U]) => (typeof key === 'string' ? (key.toLowerCase() as T[U]) : key)
    : (key: T[U]) => key;
  const indexedItems = loadedData.reduce((acc, item) => {
    const normalisedKey = normalise(item[keyName]);
    if (acc.has(normalisedKey)) {
      return acc;
    }

    acc.set(normalisedKey, item);
    return acc;
  }, new Map<T[U], T>());

  return keys.map((key) => indexedItems.get(normalise(key)) ?? null);
};

/**
 * given keys[] passed to a prisma `in` filter,
 * return the loaded data in order of the corresponding keys,
 * array-aggregating duplicate results
 * efficient version of `keys.map(key => loadedData.filter(item => item[keyName] === key))`
 */
const mapToCollection = <T, U extends keyof T>(
  keys: readonly T[U][],
  loadedData: T[],
  keyName: U,
  options: { caseInsensitive?: boolean } = {},
) => {
  const normalise = options.caseInsensitive
    ? (key: T[U]) => (typeof key === 'string' ? (key.toLowerCase() as T[U]) : key)
    : (key: T[U]) => key;
  const indexedItems = loadedData.reduce((acc, item) => {
    const val = normalise(item[keyName]);

    const existing = acc.get(val);
    if (existing) {
      existing.push(item);
      return acc;
    } else {
      acc.set(val, [item]);
      return acc;
    }
  }, new Map<T[U], T[]>());

  return keys.map((item) => indexedItems.get(normalise(item)) ?? []);
};

// Standard dataloaders for any model

type AllModels = {
  [K in keyof db.PrismaClient as db.PrismaClient[K] extends {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: (...args: any[]) => any;
  }
    ? K
    : never]: db.PrismaClient[K];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AllModelType<U extends keyof AllModels> = Awaited<ReturnType<AllModels[U]['findMany']>>[number];

type Models = {
  [K in keyof AllModels as AllModelType<K> extends { id: string } ? K : never]: AllModels[K];
};

type ModelType<U extends keyof Models> = Awaited<ReturnType<Models[U]['findMany']>>[number];

// The tenant filter these three loaders apply
//
// They are the only generic readers in the codebase: every
// `ModelService.getById` funnels through `findById`, and the loader is handed
// nothing but a model name and a key. Whatever tenant filter they applied was
// therefore whatever the CLIENT they ran on applied — an implicit scope,
// invisible at the call site, and about to be deleted (D15/D44d).
//
// Measured before it was replaced, that implicit scope was almost nothing: the
// `public` ability block is added for every authenticated non-admin user and it
// grants unconditional READ on `User`, `UserEmail`, `LegalEntity`, `RawText`,
// `Document` and `ProfileRole`. Only three of the models
// these loaders reach were ever filtered — `Team` by membership, `ApiKey` by
// team, and `UserSettings` by user (that third one has since been deleted with
// its table, C-2).
//
// So the filter is declared here, per model, and it says WHY when the answer is
// "none". An undeclared model throws rather than reading unfiltered: a loader
// that cannot say what its tenant is must not guess, and a new `ModelService`
// finding that out at its first read is the loud failure we want.

/** How a model is tenant-scoped when read through a generic loader. */
type TenantScope =
  /** `column` must equal the acting team / acting user. */
  | { column: string; equals: 'actingTeam' | 'actingUser' }
  /** Deliberately readable across tenants. The string is the reason, and it is
   *  load-bearing: every one of these is a surface a product owner has to rule
   *  on, not an oversight to be tidied away silently. */
  | { unscopedBecause: string };

const CORE_IDENTITY =
  'core-owned identity, resolved by id from every attribution read; global by construction (the Directory contract makes this explicit at export)';
const DEALFLOW = 'dealflow-era, read unscoped by the public ability today; dies with D9 in Phase 5';
const SHARED_COMPANY_GRAPH =
  'carries genuinely team-less rows (the shared company graph) — scoping it is a valuations policy call, not a leak fix';

const TENANT_SCOPES: Partial<Record<keyof Models, TenantScope>> = {
  // Filtered by CASL, and now filtered explicitly.
  team: { column: 'id', equals: 'actingTeam' },
  apiKey: { column: 'teamId', equals: 'actingTeam' },

  // Team-owned rows whose loaders are installed but never loaded today. Scoped
  // because the column is there and the row belongs to a team; no caller can
  // notice the difference, and the next one inherits the right default.
  notionToken: { column: 'teamId', equals: 'actingTeam' },
  profileEmail: { column: 'teamId', equals: 'actingTeam' },
  resource: { column: 'teamId', equals: 'actingTeam' },

  // Read across tenants today, with live callers that depend on it.
  user: { unscopedBecause: CORE_IDENTITY },
  userEmail: {
    unscopedBecause: 'the login lookup — it answers before any team is known, so it cannot be team-scoped without breaking sign-in',
  },
  magicLinkToken: {
    unscopedBecause: 'minted and redeemed before the recipient has an acting team',
  },
  legalEntity: { unscopedBecause: SHARED_COMPANY_GRAPH },
  document: {
    unscopedBecause:
      'the public document route authorises with a SIGNED capability URL rather ' +
      'than with tenancy (lib/document_link) — it runs as PUBLIC_USER, with no ' +
      'acting team to scope by, and the signature is what proves the caller was ' +
      'handed the link',
  },
  rawText: { unscopedBecause: DEALFLOW },
  profileRole: { unscopedBecause: DEALFLOW },
};

/**
 * The `teamId` condition every BESPOKE dataloader below carries.
 *
 * The bespoke loaders take a `prisma` and close over it, so they cannot be
 * handed an identity when they are built: a Context assigns `prisma` — and with
 * it a whole fresh set of loaders — in its constructor, before it learns whose
 * request it is serving. The acting team is therefore read when the BATCH runs,
 * which is the same moment `tenantFilter` reads it for the generic three.
 *
 * `{ in: [] }` matches nothing, and is the same "no identity, no tenant, no
 * rows" rule: a loader that cannot name its tenant must return nothing rather
 * than everything. It reads as a filter on both `String` and `String?` columns,
 * so the loaders over `asset` and `event` (whose `team_id` is still nullable
 * from the dealflow era) spell it the same way as the rest.
 */
function actingTeamFilter(): { equals: string } | { in: [] } {
  const teamId = unsafeCurrentContext()?.principal?.teamId;
  return teamId === undefined ? { in: [] } : { equals: teamId };
}

/** The `where` fragment that scopes a generic read to the acting tenant. */
function tenantFilter<U extends keyof Models>(key: U): Record<string, unknown> {
  const scope = TENANT_SCOPES[key];
  if (scope === undefined) {
    throw new Error(
      `No tenant scope declared for '${String(key)}'. A generic dataloader must say which ` +
        'column ties the row to the acting tenant, or say in words why the model is read ' +
        `across tenants — add '${String(key)}' to TENANT_SCOPES.`,
    );
  }
  if ('unscopedBecause' in scope) return {};

  const principal = unsafeCurrentContext()?.principal;
  const value = scope.equals === 'actingTeam' ? principal?.teamId : principal?.userId;
  // No identity, no tenant, no rows. This is the whole filter now — a context
  // with no principal must not read a scoped model wide open.
  if (value === undefined) return { id: { in: [] } };
  return { [scope.column]: value };
}

function findByIdDataloader<U extends keyof Models>(
  key: U,
): () => DataLoader<string, ModelType<U> | null> {
  type T = ModelType<U>;
  return memo(
    () =>
      new DataLoader<string, ModelType<U> | null>(async (ids) => {
        const { prisma } = currentContext();
        // typescript has trouble with generic functions with different but overlapping signatures
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items: T[] = await (prisma[key].findMany as any)({
          where: {
            AND: [
              tenantFilter(key),
              {
                id: {
                  in: [...ids], // turn ids into non-readonly
                },
              },
            ],
          },
        });
        return mapToScalar<T, 'id'>(ids, items, 'id');
      }),
  );
}

function findManyByFkDataloader<U extends keyof Models, V extends keyof ModelType<U>>(
  key: U,
  fk: V,
): () => DataLoader<ModelType<U>[V], ModelType<U>[]> {
  type T = ModelType<U>;
  return memo(
    () =>
      new DataLoader<T[V], T[]>(async (ids) => {
        const { prisma } = currentContext();
        // typescript has trouble with generic functions with different but overlapping signatures
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items: T[] = await (prisma[key].findMany as any)({
          where: {
            AND: [
              tenantFilter(key),
              {
                [fk]: {
                  in: [...ids], // turn ids into non-readonly
                },
              },
            ],
          },
        });
        return mapToCollection<T, V>(ids, items, fk);
      }),
  );
}

function findByUniqueDataloader<U extends keyof Models, V extends keyof ModelType<U>>(
  key: U,
  field: V,
  options: { caseInsensitive?: boolean } = {},
): () => DataLoader<ModelType<U>[V], ModelType<U> | null> {
  type T = ModelType<U>;
  return memo(
    () =>
      new DataLoader<T[V], T | null>(async (ids) => {
        const { prisma } = currentContext();
        // typescript has trouble with generic functions with different but overlapping signatures
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const items: T[] = await (prisma[key].findMany as any)({
          where: {
            AND: [
              tenantFilter(key),
              {
                [field]: {
                  in: [...ids], // turn ids into non-readonly
                  mode: options.caseInsensitive ? 'insensitive' : undefined,
                },
              },
            ],
          },
        });
        return mapToScalar<T, V>(ids, items, field, options);
      }),
  );
}

export {
  memo,
  actingTeamFilter,
  Dataloaders,
  defaultOptions,
  findManyByFkDataloader,
  findByIdDataloader,
  findByUniqueDataloader,
  getDataloaders,
  Models,
  ModelType,
};
