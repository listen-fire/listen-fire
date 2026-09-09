"use client";

/**
 * Ported from apps/app's PortfolioList/Changelog/index.tsx ChangelogTable —
 * same columns, rebuilt on the automations table idiom.
 */

import { formatDate } from "@/components/portfolio";
import type { ChangelogEntry } from "./types";

export function ChangelogTable({ items }: { items: ChangelogEntry[] }) {
  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-gray-100 bg-gray-50/50 text-[11px] uppercase tracking-wider text-gray-400">
            <th className="py-2.5 pl-4 pr-4 font-medium">Date</th>
            <th className="py-2.5 pr-4 font-medium">Company</th>
            <th className="py-2.5 pr-4 font-medium">Category</th>
            <th className="py-2.5 pr-4 font-medium">Description</th>
            <th className="py-2.5 pr-4 font-medium">Event date</th>
            <th className="py-2.5 pr-4 font-medium">Funds</th>
            <th className="py-2.5 pr-4 font-medium">User</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {items.map((entry) => (
            <tr key={entry.id} className="transition-colors hover:bg-gray-50">
              <td className="py-3 pl-4 pr-4 text-gray-400">
                {formatDate(new Date(entry.created_at), "MMM d, yyyy HH:mm")}
              </td>
              <td className="py-3 pr-4 font-medium text-gray-800">{entry.company_name}</td>
              <td className="py-3 pr-4 text-gray-600">{entry.category ?? ""}</td>
              <td className="py-3 pr-4">
                <Description text={entry.description} />
              </td>
              <td className="py-3 pr-4 text-gray-500">
                {entry.event_date ? formatDate(new Date(entry.event_date), "MMM d, yyyy") : ""}
              </td>
              <td className="py-3 pr-4 text-gray-500">{entry.funds.map((f) => f.name).join(", ")}</td>
              <td className="py-3 pr-4 text-gray-500">{entry.username ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Description({ text }: { text: string }) {
  const lines = text.split("\n");
  if (lines.length <= 1) return <span>{text}</span>;
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium text-gray-800">{lines[0]}</span>
      {lines.slice(1).map((line, i) => (
        <span key={i} className="text-[12px] text-gray-400">
          {line}
        </span>
      ))}
    </div>
  );
}
