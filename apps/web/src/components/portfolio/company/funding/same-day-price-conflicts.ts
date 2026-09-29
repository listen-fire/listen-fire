/**
 * Same-day price collisions — display only, no engine change.
 *
 * The valuation engine resolves one price per company per date from
 * `valuations.price` rows scoped either to the company itself
 * (`asset_id` null, "price per share") or to one of its equity assets
 * (`asset_id` set). A company-level row feeds every equity asset the
 * company has, so it competes with each of them on a shared date, and two
 * rows in the same scope (two company-level rows, or two rows on the same
 * asset) compete with each other too. Two DIFFERENT assets each priced
 * once on the same day are not a collision — they're different equities,
 * not competing quotes for the same one.
 *
 * This module only detects and describes that collision for the UI; it
 * does not reach into the engine's own tie-break.
 */

import type { CurrencyIsoCode } from "#trpc";

export type SameDayConflictScope = "company" | "asset";

export type SameDayConflictPrice = {
  id: string;
  value: number;
  currency: CurrencyIsoCode;
  scope: SameDayConflictScope;
  assetName?: string;
};

export type SameDayPriceConflict = {
  date: string;
  prices: SameDayConflictPrice[];
};

export type SameDayConflictSourceRow = {
  id: string;
  date: string | Date;
  price: number;
  currency: CurrencyIsoCode;
  asset_id: string | null | undefined;
  name?: string | null;
};

export function dateKey(date: string | Date): string {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().slice(0, 10);
}

function toConflictPrice(row: SameDayConflictSourceRow): SameDayConflictPrice {
  return {
    id: row.id,
    value: row.price,
    currency: row.currency,
    scope: row.asset_id ? "asset" : "company",
    assetName: row.asset_id ? (row.name ?? undefined) : undefined,
  };
}

/**
 * Every same-day collision among `rows`, one entry per calendar date that
 * has one, newest date first.
 */
export function findSameDayPriceConflicts(
  rows: SameDayConflictSourceRow[],
): SameDayPriceConflict[] {
  const byDate = new Map<string, SameDayConflictSourceRow[]>();
  for (const row of rows) {
    const key = dateKey(row.date);
    const group = byDate.get(key);
    if (group) {
      group.push(row);
    } else {
      byDate.set(key, [row]);
    }
  }

  const conflicts: SameDayPriceConflict[] = [];
  for (const [date, dateRows] of byDate) {
    const companyRows = dateRows.filter((row) => !row.asset_id);
    const assetRows = dateRows.filter((row) => row.asset_id);

    let competing: SameDayConflictSourceRow[];
    if (companyRows.length > 1 || (companyRows.length >= 1 && assetRows.length >= 1)) {
      // A company-level row prices every equity asset, so it competes with
      // all of them (and with any other company-level row) that day.
      competing = [...companyRows, ...assetRows];
    } else {
      const byAsset = new Map<string, SameDayConflictSourceRow[]>();
      for (const row of assetRows) {
        const assetId = row.asset_id as string;
        const group = byAsset.get(assetId);
        if (group) {
          group.push(row);
        } else {
          byAsset.set(assetId, [row]);
        }
      }
      competing = Array.from(byAsset.values())
        .filter((group) => group.length > 1)
        .flat();
    }

    if (competing.length > 1) {
      conflicts.push({ date, prices: competing.map(toConflictPrice) });
    }
  }

  return conflicts.sort((a, b) => (a.date < b.date ? 1 : -1));
}
