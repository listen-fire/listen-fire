"use client";

import { formatMoney, formatTvpi } from "@/components/portfolio";
import { trpc } from "@/lib/trpc";
import { toApiFilter, toApiConfig } from "./api-params";
import type { PortfolioConfig, PortfolioFilter } from "./types";

export function TotalsRow({
  filter,
  config,
}: {
  filter: PortfolioFilter;
  config: PortfolioConfig;
}) {
  const { data: totals, isLoading } = trpc.views.investments.getPortfolioTotals.useQuery(
    { filter: toApiFilter(filter), config: toApiConfig(config) },
    { keepPreviousData: true },
  );

  if (isLoading || !totals) return null;

  const currency = totals.currency;

  return (
    <div className="mb-3 flex items-center justify-between rounded-xl border border-gray-100 bg-gray-50/50 px-4 py-3">
      <span className="text-[13px] font-semibold text-gray-700">Portfolio totals</span>
      <div className="grid grid-cols-4 gap-6 text-right">
        <Stat label="Invested" value={formatMoney(totals.totalInvested, { currency, isAbbrFormat: true, maximumFractionDigits: 2 })} />
        <Stat label="Retained" value={formatMoney(totals.unrealizedValue, { currency, isAbbrFormat: true, maximumFractionDigits: 2 })} />
        <Stat label="Realized" value={formatMoney(totals.realizedValue, { currency, isAbbrFormat: true, maximumFractionDigits: 2 })} />
        <Stat label="MOIC" value={formatTvpi(totals.moic)} />
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-end gap-0.5">
      <span className="text-[11px] font-medium text-gray-400">{label}</span>
      <span className="text-[13px] font-semibold text-gray-800">{value}</span>
    </div>
  );
}
