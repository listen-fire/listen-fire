"use client";

/**
 * Shares a fund took in this company as payment for another company being
 * acquired. They are kept out of this page's invested / retained / realized
 * figures (the value already counts on the acquired company's line), so they
 * get their own list rather than a place in the summary.
 */

import { Handshake } from "lucide-react";
import Link from "next/link";

import { formatDate, formatMoney, formatTvpi } from "@/components/portfolio";

import { HistoryItemBox } from "./funding/common";
import type { Company } from "./types";

type Acquisition = Exclude<Company, null>["acquisitions"][number];

export function AcquisitionsSection({
  acquisitions,
}: {
  acquisitions: Acquisition[];
}) {
  return (
    <div className="flex flex-col items-stretch gap-3">
      <h2 className="text-[15px] font-medium text-gray-900">Acquisitions</h2>
      <div className="flex flex-col items-stretch gap-4">
        {acquisitions.map((acquisition) => (
          <AcquisitionItem key={acquisition.investmentId} acquisition={acquisition} />
        ))}
      </div>
    </div>
  );
}

function AcquisitionItem({ acquisition }: { acquisition: Acquisition }) {
  const money = (value: number | null) =>
    formatMoney(value, {
      currency: acquisition.currency,
      isAbbrFormat: true,
      maximumFractionDigits: 2,
    });
  const shares =
    acquisition.sharesReceived.length > 0
      ? acquisition.sharesReceived
          .map((share) => `${share.quantity.toLocaleString()} ${share.assetName}`)
          .join(" and ")
      : "no shares";

  return (
    <HistoryItemBox
      size="sm"
      title={{ icon: <Handshake />, title: acquisition.acquiredCompany.name }}
      infoLine={
        <span className="text-[13px] text-gray-400">
          Received {shares} on {formatDate(new Date(acquisition.date), "MMM d, yyyy")} for{" "}
          {acquisition.acquiredCompany.slug ? (
            <Link
              href={`/portfolio/c/${acquisition.acquiredCompany.slug}`}
              className="text-primary hover:underline"
            >
              {acquisition.acquiredCompany.name}
            </Link>
          ) : (
            acquisition.acquiredCompany.name
          )}{" "}
          ({acquisition.fund.name}); cost carried over {money(acquisition.acquiredCompanyCost)};
          value now {money(acquisition.valueNow)}
          {acquisition.cashReceived !== null
            ? `; cash received ${money(acquisition.cashReceived)}`
            : ""}
          ; {formatTvpi(acquisition.multiple)}
        </span>
      }
    />
  );
}
