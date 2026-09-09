"use client";

/**
 * The "tune" popover from apps/app's Header.tsx ConfigBox — grouping, sort,
 * currency, and value-as-of date. `fair_value` grouping is
 * deliberately excluded from the UI (router still accepts it).
 */

import { useEffect, useRef, useState } from "react";
import { SlidersHorizontal } from "lucide-react";

import { CurrencySelect } from "./currency-select";
import type { Aggregation, Grouping, PortfolioConfig, PortfolioFilter } from "./types";

const SORT_OPTIONS: { value: Grouping; label: string }[] = [
  { value: "investment_date", label: "Investment date" },
  { value: "moic", label: "MOIC" },
  { value: "total_value", label: "Total value" },
];

const AGGREGATION_OPTIONS: { value: Aggregation; label: string }[] = [
  { value: "company", label: "Company" },
  { value: "investment", label: "Investment" },
];

export function ConfigPanel({
  filter,
  setFilter,
  config,
  setConfig,
}: {
  filter: PortfolioFilter;
  setFilter: (updater: (f: PortfolioFilter) => PortfolioFilter) => void;
  config: PortfolioConfig;
  setConfig: (updater: (c: PortfolioConfig) => PortfolioConfig) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 text-gray-500 hover:bg-gray-50"
      >
        <SlidersHorizontal size={15} />
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-72 rounded-xl border border-gray-100 bg-white p-4 shadow-lg">
          <div className="grid grid-cols-[1fr_1.4fr] items-center gap-x-3 gap-y-3">
            <span className="text-[12px] font-medium text-gray-500">Grouping</span>
            <select
              value={config.aggregation}
              onChange={(e) =>
                setConfig((c) => ({ ...c, aggregation: e.target.value as Aggregation }))
              }
              className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-[13px]"
            >
              {AGGREGATION_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <span className="text-[12px] font-medium text-gray-500">Sort</span>
            <select
              value={filter.grouping}
              onChange={(e) => setFilter((f) => ({ ...f, grouping: e.target.value as Grouping }))}
              className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-[13px]"
            >
              {SORT_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>

            <span className="text-[12px] font-medium text-gray-500">Currency</span>
            <CurrencySelect
              value={config.currency}
              onChange={(currency) => setConfig((c) => ({ ...c, currency }))}
            />

            <span className="text-[12px] font-medium text-gray-500">Value as of</span>
            <input
              type="date"
              value={config.valuationDate ?? ""}
              onChange={(e) =>
                setConfig((c) => ({ ...c, valuationDate: e.target.value || null }))
              }
              className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-[13px]"
            />
          </div>
        </div>
      )}
    </div>
  );
}
