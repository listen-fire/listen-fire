import {
  findSameDayPriceConflicts,
  type SameDayConflictSourceRow,
} from "../same-day-price-conflicts";

// `#trpc` is a value import only for its enum runtime objects; pulling it in
// here would load the generated router (packages/trpc/types.ts), which isn't
// safe to import outside the Next.js build. `CurrencyIsoCode` is a plain
// string enum, so a literal stands in for it under `import type`.
import type { CurrencyIsoCode } from "#trpc";

const USD = "USD" as CurrencyIsoCode;

function row(overrides: Partial<SameDayConflictSourceRow> & { id: string }): SameDayConflictSourceRow {
  return {
    date: "2024-09-12",
    price: 1,
    currency: USD,
    asset_id: null,
    name: null,
    ...overrides,
  };
}

describe("findSameDayPriceConflicts", () => {
  it("flags a company-level row plus an asset-level row on the same day", () => {
    const rows = [
      row({ id: "company", asset_id: null, price: 6.59 }),
      row({ id: "shares", asset_id: "asset-1", name: "Shares", price: 40 }),
    ];

    const conflicts = findSameDayPriceConflicts(rows);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].date).toBe("2024-09-12");
    expect(conflicts[0].prices.map((p) => p.id).sort()).toEqual(["company", "shares"]);
  });

  it("does not flag two different assets each priced once on the same day", () => {
    const rows = [
      row({ id: "common", asset_id: "asset-1", name: "Common", price: 10 }),
      row({ id: "preferred", asset_id: "asset-2", name: "Preferred", price: 20 }),
    ];

    expect(findSameDayPriceConflicts(rows)).toEqual([]);
  });

  it("flags two rows on the same asset on the same day", () => {
    const rows = [
      row({ id: "a", asset_id: "asset-1", name: "Shares", price: 40 }),
      row({ id: "b", asset_id: "asset-1", name: "Shares", price: 42 }),
    ];

    const conflicts = findSameDayPriceConflicts(rows);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].prices.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("does not flag rows on different days", () => {
    const rows = [
      row({ id: "company", asset_id: null, date: "2024-09-12", price: 6.59 }),
      row({ id: "shares", asset_id: "asset-1", name: "Shares", date: "2024-09-13", price: 40 }),
    ];

    expect(findSameDayPriceConflicts(rows)).toEqual([]);
  });

  it("flags two company-level rows on the same day", () => {
    const rows = [
      row({ id: "a", asset_id: null, price: 6.59 }),
      row({ id: "b", asset_id: null, price: 7.1 }),
    ];

    const conflicts = findSameDayPriceConflicts(rows);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].prices.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });

  it("sorts multiple conflicting dates newest first", () => {
    const rows = [
      row({ id: "a1", asset_id: null, date: "2024-01-01", price: 1 }),
      row({ id: "a2", asset_id: "asset-1", date: "2024-01-01", price: 2 }),
      row({ id: "b1", asset_id: null, date: "2024-06-01", price: 1 }),
      row({ id: "b2", asset_id: "asset-1", date: "2024-06-01", price: 2 }),
    ];

    const conflicts = findSameDayPriceConflicts(rows);

    expect(conflicts.map((c) => c.date)).toEqual(["2024-06-01", "2024-01-01"]);
  });
});
