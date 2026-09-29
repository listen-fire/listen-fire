"use client";

/**
 * "How this was calculated" modal — renders the valuation engine's trace of
 * one line (ported from apps/app's Investments.tsx MessageRenderer). Clicking
 * any of the money/MOIC cells opens this.
 *
 * The trace is asked for when the modal opens: it is far bigger than the rest
 * of the list put together, and a reader looks at one company's at a time.
 */

import { FormModal } from "@/components/portfolio";
import { trpc } from "@/lib/trpc";
import type { Investment, PortfolioConfig, ProcessMessage } from "./types";

function MessageRenderer({ message }: { message: ProcessMessage }) {
  if (message.type === "header") {
    return <div className="mb-1.5 mt-4 text-[14px] font-semibold text-gray-900 first:mt-0">{message.content}</div>;
  }

  if (message.type === "table") {
    const { headers, rows } = message.content;
    return (
      <div className="my-3 overflow-x-auto rounded-lg border border-gray-100">
        <table className="w-full text-left text-[12px]">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/50 text-[11px] uppercase tracking-wider text-gray-400">
              {headers.map((header, i) => (
                <th key={i} className="px-3 py-2 font-medium">
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td key={j} className="whitespace-pre-wrap px-3 py-1.5">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div className="whitespace-pre-wrap font-mono text-[12px] text-gray-600">{message.content}</div>
  );
}

export function InvestmentDetailModal({
  isOpen,
  onClose,
  investments,
  config,
}: {
  isOpen: boolean;
  onClose: () => void;
  investments: Investment["investments"];
  config: PortfolioConfig;
}) {
  const rowInvestments = (investments ?? []).map((i) => ({ id: i.id, date: i.date }));
  const { data, isLoading } = trpc.views.investments.getInvestmentCalculation.useQuery(
    {
      investments: rowInvestments,
      config: {
        currency: config.currency ?? undefined,
        valuationDate: config.valuationDate ?? undefined,
      },
    },
    { enabled: isOpen && rowInvestments.length > 0 },
  );
  const messages = data?.message;

  return (
    <FormModal isOpen={isOpen} onClose={onClose} title="How this was calculated" size="xl">
      {isLoading && rowInvestments.length > 0 ? (
        <div className="text-[13px] text-gray-400">Working it out…</div>
      ) : messages?.length ? (
        messages.map((msg, i) => <MessageRenderer key={i} message={msg} />)
      ) : (
        <div className="text-[13px] text-gray-400">No calculation detail available.</div>
      )}
    </FormModal>
  );
}
