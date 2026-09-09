"use client";

/**
 * Changelog's own thin filter bar (rebuilt, not a port of FilterSelect) —
 * company name, fund, category, and a date range.
 */

import { useEffect, useMemo, useState } from "react";

import { trpc } from "@/lib/trpc";

export interface ChangelogFilter {
  companyName: string | null;
  fundIds: string[];
  categories: string[];
  fromDate: string | null;
  toDate: string | null;
}

const inputClass =
  "w-full rounded-md border border-gray-200 px-2 py-1.5 text-[13px] focus:border-gray-400 focus:outline-none";

export function ChangelogFilterBar({
  filter,
  setFilter,
}: {
  filter: ChangelogFilter;
  setFilter: (updater: (f: ChangelogFilter) => ChangelogFilter) => void;
}) {
  const [nameInput, setNameInput] = useState(filter.companyName ?? "");

  useEffect(() => {
    setNameInput(filter.companyName ?? "");
  }, [filter.companyName]);

  useEffect(() => {
    const handle = setTimeout(() => {
      const next = nameInput || null;
      setFilter((f) => (f.companyName === next ? f : { ...f, companyName: next }));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, 300);
    return () => clearTimeout(handle);
  }, [nameInput]);

  const { data: portfolios } = trpc.views.portfolio.company.getAllPortfolios.useQuery();
  const { data: categories } = trpc.views.portfolio.company.getChangelogCategories.useQuery();
  // Slimmed to {id,name} outside JSX — see filter-bar.tsx for why this is a
  // for-of, not `.map` (TS2589 on the full LegalEntity result's recursive
  // `linkedinData: JsonValue` field).
  const portfolioOptions = useMemo(() => {
    const options: { id: string; name: string }[] = [];
    for (const { id, name } of portfolios ?? []) {
      options.push({ id, name: name ?? "???" });
    }
    return options;
  }, [portfolios]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        type="text"
        value={nameInput}
        onChange={(e) => setNameInput(e.target.value)}
        placeholder="Search companies"
        className={`${inputClass} w-48`}
      />

      <select
        value={filter.fundIds[0] ?? ""}
        onChange={(e) =>
          setFilter((f) => ({ ...f, fundIds: e.target.value ? [e.target.value] : [] }))
        }
        className={`${inputClass} w-auto`}
      >
        <option value="">Fund</option>
        {portfolioOptions.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <select
        value={filter.categories[0] ?? ""}
        onChange={(e) =>
          setFilter((f) => ({ ...f, categories: e.target.value ? [e.target.value] : [] }))
        }
        className={`${inputClass} w-auto`}
      >
        <option value="">Category</option>
        {categories?.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>

      <input
        type="date"
        value={filter.fromDate ?? ""}
        onChange={(e) => setFilter((f) => ({ ...f, fromDate: e.target.value || null }))}
        className={`${inputClass} w-auto`}
        title="From"
      />
      <input
        type="date"
        value={filter.toDate ?? ""}
        onChange={(e) => setFilter((f) => ({ ...f, toDate: e.target.value || null }))}
        className={`${inputClass} w-auto`}
        title="To"
      />
    </div>
  );
}
