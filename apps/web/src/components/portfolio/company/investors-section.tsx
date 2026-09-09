"use client";

/**
 * Port of apps/app's Portfolio/Profile/InvestorsSection.tsx — the "who else
 * is in this deal" grid, sourced from getInvestorsSummary rather than the
 * company's own investments. Renders as Co-Investors within Overview; the
 * dedicated "Co-Investors" tab (V-15) does not port, so its disclosure
 * button is dropped along with the destination it pointed at.
 */

import { Section } from "@/components/portfolio";
import { trpc } from "@/lib/trpc";

import type { Company } from "./types";

export function InvestorsSection({ company }: { company: Company }) {
  const { data } = trpc.views.portfolio.company.getInvestorsSummary.useQuery({
    legalEntityId: company?.id ?? "",
  });

  const investors = data?.rounds
    .filter((round) => round.event_id !== null)
    .filter((round) => round.event_type === "INVESTMENT_ROUND")
    .flatMap((round) =>
      round.private.map((investor) => ({
        name: investor.name,
        round: round.event_name,
      })),
    );

  return (
    <Section title="Co-Investors">
      {investors?.length === 0 && (
        <p className="text-[12px] text-gray-500">No co-investors found</p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {investors?.map((investor, i) => (
          <InvestorCard key={`${investor.name}-${i}`} name={investor.name ?? ""} roundName={investor.round} />
        ))}
      </div>
    </Section>
  );
}

function InvestorCard({ name, roundName }: { name: string; roundName?: string | null }) {
  const initials = name.trim().slice(0, 2).toUpperCase();
  return (
    <div className="flex items-center gap-2.5 overflow-hidden">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary/80 text-[10px] font-semibold text-white">
        {initials}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="truncate text-[13px] text-gray-900">{name}</div>
        <div className="truncate text-[12px] text-gray-500">{roundName ?? ""}</div>
      </div>
    </div>
  );
}
