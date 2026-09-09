"use client";

/**
 * Port of apps/app's Portfolio/Profile/Overview.tsx, minus its
 * UpdatesSection and DealMemos branches (V-15 — dealflow-shell surfaces
 * don't port). The source fell through to DealMemos when a company had no
 * investments; that destination is gone, so a plain empty state stands in.
 *
 * apps/app's tiny InvestmentSection.tsx (the react-router wrapper that gave
 * the summary its "Details" jump to the Funding tab) doesn't get its own
 * file here — the querystring wiring is inlined, since Funding is a real
 * (surviving) tab in this port.
 */

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PackageOpen } from "lucide-react";

import { EmptyState } from "@/components/ui";

import type { Company } from "./types";
import { InvestmentSummarySection } from "./investment-summary";
import { InvestorsSection } from "./investors-section";

export function Overview({ company }: { company: Company }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();

  if (!company?.investments || company.investments.length === 0) {
    return (
      <EmptyState
        icon={<PackageOpen size={22} />}
        title="No recorded investments yet."
        caption="Once an investment is added for this company, its funding summary and co-investors will show up here."
      />
    );
  }

  const goToFunding = () => {
    const next = new URLSearchParams(searchParams.toString());
    next.set("tab", "funding");
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  return (
    <div className="flex flex-col gap-8">
      <InvestmentSummarySection
        company={company}
        disclosureTitle="Details"
        disclosureAction={goToFunding}
      />
      <InvestorsSection company={company} />
    </div>
  );
}
