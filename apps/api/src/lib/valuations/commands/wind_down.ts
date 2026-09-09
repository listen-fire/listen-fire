import * as db from '@prisma/client';
import { z } from 'zod';

import { currentContext } from '../../../services/context';
import { getCurrencyAsset } from '../../datasources/asset';
import { getInventoryForInvestments } from '../inventory';
import { getAssetTrackedEntities } from '../valuation/data';
import CurrencyIsoCode from '../../../generated/kysely/valuations/CurrencyIsoCode';

/**
 * `applyWindDown`'s input, exported as the single zod source of truth — both
 * the tRPC mutation (company.ts) and the REST command route
 * (interfaces/rest/v1/valuations/commands.ts) parse against this schema
 * rather than hand-duplicating the field list.
 *
 * `transactions` stays OPTIONAL here for tab parity — the movement action
 * never sends it (wind-down is a single write off the Legal Entity with just
 * `Date`), but the Funding-tab form still passes its per-investor payouts,
 * and that loop naturally no-ops when the array is absent/empty.
 */
export const applyWindDownInput = z.object({
  companyId: z.string(),
  date: z.string().date(),
  transactions: z
    .array(z.object({ numAssets: z.number(), currency: z.string(), investorId: z.string() }))
    .optional(),
});

export type ApplyWindDownInput = z.infer<typeof applyWindDownInput>;

/** A held position that tracks the wound-down company and must be disposed:
 *  which investing entity holds how many of which asset, and the asset's issuer
 *  (the entity its price resolves against, and the default disposal sink). */
export interface TrackedDisposal {
  investingEntityId: string;
  assetId: string;
  assetName: string;
  numAssets: number;
  /** The asset's issuing entity (falls back to the company when unknown). */
  issuerId: string;
}

/**
 * THE disposal-sink seam. On a wind-down the holder's tracking positions are
 * extinguished out of its inventory; this decides WHERE they go. Today that's
 * the asset's own issuer — shares returned to the (dissolving) issuer, which
 * needs no new modelling and is representable under the NOT-NULL
 * `to_legal_entity_id`. If we adopt a synthetic void legal entity, this single
 * function is the only thing that changes.
 */
export function disposalSink({ issuerId }: { issuerId: string; companyId: string }): string {
  return issuerId;
}

/**
 * Every held position that TRACKS the wound-down company as of `date` — the
 * same tracked-entity resolution the valuation walk uses
 * (`getAssetTrackedEntities`: issuer / issuer's `underlying_company_id` / an SPV
 * interest's `spv_investment_target_company_id`). So a holding under an
 * investment profiled to the SPV itself, or equity issued by an SPV wrapper
 * over the company, is included — not just assets under investments literally
 * profiled to the company.
 *
 * Pure read: computes what WOULD be disposed. Both the live command and the
 * backfill's `--dry-run` call this; the writer (`disposeTrackedHoldings`) is
 * this plus the markdown + transfer writes.
 */
export async function planTrackedDisposals({
  companyId,
  date,
}: {
  companyId: string;
  date: Date;
}): Promise<TrackedDisposal[]> {
  const ctx = currentContext();

  // An asset tracking the company can be held under an investment profiled to
  // the company, to a wrapping SPV, or (for a received SPV interest) elsewhere.
  // Roll up the whole portfolio's inventory as of the date and let the
  // tracked-entity resolution below pick the actual claims on this company.
  // (The rollup bounds transactions by `close_date <= asOfDate`, so no separate
  // `investedAt` cutoff is needed — and one would silently drop holdings whose
  // investment has no recorded `investedAt`.)
  const investments = await ctx.prisma.investment.findMany({
    where: {
      teamId: ctx.user.teamId,
      legalEntityInvestmentInvestorProfileIdTolegalEntity: {
        OR: [{ isPortfolio: true }, { isOwnInvestingEntity: true }],
      },
    },
  });

  const holdings = await getInventoryForInvestments({
    investmentIds: investments.map((i) => i.id),
    asOfDate: date,
  });

  type HeldPosition = {
    investingEntityId: string;
    assetId: string;
    assetName: string;
    numAssets: number;
  };
  const positions: HeldPosition[] = [];
  const heldAssetIds = new Set<string>();
  for (const [investingEntityKey, , entityHoldings] of holdings.entries()) {
    const investingEntityId = investingEntityKey.split(':')[0];
    for (const [assetKey, holding] of entityHoldings.entries()) {
      const [assetId, assetName, assetType] = assetKey.split(':');
      if (assetType === 'CURRENCY') continue;
      const { fromInvestment, fromOtherTransactions } = holding.sum();
      const numAssets = fromInvestment + fromOtherTransactions;
      if (numAssets <= 0) continue;
      positions.push({ investingEntityId, assetId, assetName, numAssets });
      heldAssetIds.add(assetId);
    }
  }

  const trackedEntities = await getAssetTrackedEntities([...heldAssetIds]);
  const disposedAssetIds = new Set(
    [...heldAssetIds].filter((id) => trackedEntities.get(id)?.has(companyId)),
  );
  if (!disposedAssetIds.size) return [];

  const assets = await ctx.prisma.asset.findMany({
    where: { teamId: ctx.user.teamId, id: { in: [...disposedAssetIds] } },
    select: { id: true, issuedByLegalEntityId: true },
  });
  const issuerByAsset = new Map(
    assets.map((a) => [a.id, a.issuedByLegalEntityId ?? companyId] as const),
  );

  return positions
    .filter((p) => disposedAssetIds.has(p.assetId))
    .map((p) => ({ ...p, issuerId: issuerByAsset.get(p.assetId) ?? companyId }));
}

/**
 * Disposes every tracking position against an EXISTING liquidation event:
 * marks each disposed asset to zero and transfers it out to the void, stamping
 * both with `eventId` and dating them `date`. Shared by `applyWindDown` (which
 * passes the event it just created) and the backfill (which passes a
 * pre-existing liquidation event — no new event, no status change).
 *
 * Idempotent: positions already netted to zero don't appear in the plan, and a
 * markdown or transfer already stamped with this event is skipped — so a
 * re-run is a no-op. The `price (asset_id, date)` unique is never tripped: an
 * asset held by several entities is marked once, and an asset that already has
 * ANY price on the disposal date keeps it instead of getting a second mark.
 *
 * Returns the positions it disposed (empty on a no-op re-run).
 */
export async function disposeTrackedHoldings({
  companyId,
  date,
  eventId,
}: {
  companyId: string;
  date: Date;
  eventId: string;
}): Promise<TrackedDisposal[]> {
  const ctx = currentContext();

  const disposals = await planTrackedDisposals({ companyId, date });
  if (!disposals.length) return [];

  // A mark is "already there" if this event wrote it (re-run) OR any price
  // exists for the asset on the disposal date (the `(asset_id, date)` unique
  // means we couldn't write another one anyway — the day already has a mark).
  const [existingMarks, existingTransfers] = await Promise.all([
    ctx.prisma.price.findMany({
      where: {
        teamId: ctx.user.teamId,
        OR: [{ eventId }, { assetId: { in: disposals.map((d) => d.assetId) }, date }],
      },
      select: { assetId: true },
    }),
    ctx.prisma.assetTransfer.findMany({
      where: { teamId: ctx.user.teamId, transaction: { eventId } },
      select: { assetId: true, fromLegalEntityId: true },
    }),
  ]);
  const markedAssetIds = new Set(existingMarks.map((p) => p.assetId));
  const transferredKeys = new Set(
    existingTransfers.map((t) => `${t.assetId}:${t.fromLegalEntityId}`),
  );

  // Mark each disposed asset to zero, keyed to the asset AND its issuer so the
  // per-issuer equity price lookup zeroes SPV-issued equity too (a company-wide
  // price keyed only to the company would miss it). Kept even though the void
  // transfer closes the holding: unrealised value sums only investment-sourced
  // flows, and a one-way outflow's proportional attribution isn't guaranteed to
  // zero that bucket exactly, so the price=0 is the robust guarantee that
  // valuation-date unrealised reads zero.
  for (const disposal of disposals) {
    // The same asset can appear once per holding entity — mark it once.
    if (markedAssetIds.has(disposal.assetId)) continue;
    markedAssetIds.add(disposal.assetId);
    await ctx.prisma.price.create({
      data: {
        assetId: disposal.assetId,
        legalEntityId: disposal.issuerId,
        date,
        teamId: ctx.user.teamId,
        price: 0,
        currency: 'USD',
        type: 'FROM_PRICED_ROUND',
        eventId,
      },
    });
  }

  // Transfer disposed positions to the void — a pure one-way outflow (no
  // counterparty asset flows in), classified ONE_WAY_TRANSACTION, so it creates
  // neither realised proceeds nor an investment flow.
  //
  // ONE disposal transaction PER ISSUER, not one for everything: the inventory
  // walk keys every transfer in a transaction under a single anchor investee
  // (the first tracked asset's). A mixed-issuer transaction would therefore book
  // the SPV-issued outflows under the company's bucket and leave the real
  // holdings (under the SPV's bucket) untouched — value zeroes via the markdown
  // but the position never closes. Grouping by issuer keeps every transfer's
  // investee equal to the bucket its holding actually sits in.
  const transfersToCreate = disposals.filter(
    (d) => !transferredKeys.has(`${d.assetId}:${d.investingEntityId}`),
  );
  const byIssuer = new Map<string, TrackedDisposal[]>();
  for (const disposal of transfersToCreate) {
    const group = byIssuer.get(disposal.issuerId) ?? [];
    group.push(disposal);
    byIssuer.set(disposal.issuerId, group);
  }

  for (const group of byIssuer.values()) {
    const { id: disposalTransactionId } = await ctx.prisma.transaction.create({
      data: { closeDate: date, eventId, teamId: ctx.user.teamId },
    });

    for (const disposal of group) {
      await ctx.prisma.assetTransfer.create({
        data: {
          assetId: disposal.assetId,
          date,
          fromLegalEntityId: disposal.investingEntityId,
          toLegalEntityId: disposalSink({ issuerId: disposal.issuerId, companyId }),
          numAssets: disposal.numAssets,
          transactionId: disposalTransactionId,
          teamId: ctx.user.teamId,
        },
      });
    }
  }

  return disposals;
}

/**
 * Records a company's wind-down: a `LIQUIDATION` (`Wind Down`) event, disposes
 * every held position that TRACKS the company (marking it to zero and
 * transferring it to the void), optionally runs the tab's per-investor
 * cash-payout transfers, and sets the company DISSOLVED.
 *
 * Everything runs inside one transaction. The transaction boundary is the
 * CALLER's responsibility (`ctx.enterTransaction()` before invoking this),
 * not this service's — a reusable command must not leak a transaction into
 * whatever the caller does next.
 */
export async function applyWindDown(input: ApplyWindDownInput): Promise<{ eventId: string }> {
  const ctx = currentContext();
  if (!ctx.inTransaction) {
    throw new Error('applyWindDown must run inside a transaction — the caller owns the transaction boundary');
  }

  const date = new Date(input.date);

  const event = await ctx.prisma.event.create({
    data: {
      name: 'Wind Down',
      type: db.EventType.LIQUIDATION,
      date,
      legalEntityId: input.companyId,
      teamId: ctx.user.teamId,
    },
  });

  await disposeTrackedHoldings({ companyId: input.companyId, date, eventId: event.id });

  for (const transaction of input.transactions ?? []) {
    // Zero proceeds = no payout — don't book an empty cash transfer.
    if (!transaction.numAssets) continue;

    const { id: transactionId } = await ctx.prisma.transaction.create({
      data: {
        closeDate: date,
        eventId: event.id,
        teamId: ctx.user.teamId,
      },
    });

    const currencyAsset = await getCurrencyAsset(transaction.currency as CurrencyIsoCode, ctx);

    await ctx.prisma.assetTransfer.create({
      data: {
        assetId: currencyAsset.id,
        date,
        fromLegalEntityId: input.companyId,
        toLegalEntityId: transaction.investorId,
        numAssets: transaction.numAssets,
        transactionId: transactionId,
        teamId: ctx.user.teamId,
      },
    });
  }

  await ctx.prisma.legalEntity.update({
    where: {
      id: input.companyId,
    },
    data: {
      legalStatus: 'DISSOLVED',
    },
  });

  return { eventId: event.id };
}
