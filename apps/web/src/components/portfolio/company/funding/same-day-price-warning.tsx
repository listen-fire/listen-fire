"use client";

import { TriangleAlert } from "lucide-react";

import { formatDate, formatMoney } from "@/components/portfolio";

import {
  resolvedConflictPrice,
  type SameDayConflictPrice,
  type SameDayPriceConflict,
} from "./same-day-price-conflicts";

function describePrice(price: SameDayConflictPrice): string {
  const where = price.scope === "company" ? "the company" : (price.assetName ?? "an asset");
  return `${formatMoney(price.value, { currency: price.currency })} on ${where}`;
}

function describeWinner(price: SameDayConflictPrice): string {
  return price.scope === "company"
    ? "the company-level price"
    : `the price on ${price.assetName ?? "the asset"}`;
}

/** Two prices competed for the same day; say so and say which one wins. */
export function SameDayPriceWarning({ conflict }: { conflict: SameDayPriceConflict }) {
  const winner = resolvedConflictPrice(conflict);

  // Asset-level rows read first, company-level last — the order a reader
  // resolves the collision in: "here's the competition, here's the tie."
  const ordered = [
    ...conflict.prices.filter((price) => price.scope === "asset"),
    ...conflict.prices.filter((price) => price.scope === "company"),
  ];

  return (
    <div className="flex items-start gap-2 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-[13px] text-orange-700">
      <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-orange-500" />
      <span>
        Two prices apply on {formatDate(new Date(conflict.date), "MMM d, yyyy")}:{" "}
        {ordered.map(describePrice).join(", ")}. The valuation uses {describeWinner(winner)}.
        Keep one.
      </span>
    </div>
  );
}
