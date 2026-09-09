"use client";

/**
 * Port of apps/app's Portfolio/Profile/Investment.tsx — a five-stat summary
 * row (Total investment, Retained, Realized, Overall MOIC, Latest round).
 * Every conditional here is kept exactly as the source has it; only the
 * Chakra Stat/HStack markup became flex/grid.
 */

import { ChevronRight } from "lucide-react";

import {
  Section,
  convertUnderscore,
  formatDate,
  formatMoney,
  formatTvpi,
} from "@/components/portfolio";
import { CurrencyIsoCode } from "#trpc";

import type { Company } from "./types";

export function InvestmentSummarySection({
  company,
  currency = CurrencyIsoCode.USD,
  disclosureTitle,
  disclosureAction,
}: {
  company: Company;
  currency?: CurrencyIsoCode;
  disclosureTitle?: string;
  disclosureAction?: () => void;
}) {
  return (
    <Section
      title="Summary"
      action={
        disclosureTitle && disclosureAction ? (
          <button
            type="button"
            onClick={disclosureAction}
            className="flex items-center gap-1 rounded-lg px-2 py-1 text-[13px] font-medium text-gray-900 transition-colors hover:bg-gray-100"
          >
            {disclosureTitle}
            <ChevronRight size={14} />
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-6">
        <Stat
          label="Total investment"
          value={formatMoney(company?.invested, {
            currency,
            isAbbrFormat: true,
            maximumFractionDigits: 2,
          })}
          sub={
            company?.firstInvested
              ? `Initial ${formatDate(new Date(company.firstInvested), "MMM yyyy")}`
              : undefined
          }
        />

        <Stat
          label="Retained"
          value={formatMoney(company?.value, {
            currency,
            isAbbrFormat: true,
            maximumFractionDigits: 2,
          })}
        />

        <Stat
          label="Realized"
          value={formatMoney(company?.realizedValue, {
            currency,
            isAbbrFormat: true,
            maximumFractionDigits: 2,
          })}
        />

        <Stat
          label="Overall MOIC"
          value={
            company?.invested && company.value !== null && company.value !== undefined
              ? formatTvpi(company.moic)
              : "No data"
          }
        />

        <Stat
          label="Latest round"
          value={convertUnderscore(company?.latestRound?.roundType ?? "N/A")}
          sub={
            company?.latestRound?.valuation.valuationType &&
            company?.latestRound?.valuation.value ? (
              <>
                {formatMoney(company.latestRound.valuation.value, {
                  currency,
                  isAbbrFormat: true,
                  maximumFractionDigits: 2,
                })}{" "}
                {convertUnderscore(company.latestRound.valuation.valuationType)}
                {company.latestRound.isConvertible ? " Cap" : ""}
              </>
            ) : undefined
          }
        />
      </div>
    </Section>
  );
}

function Stat({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="whitespace-nowrap text-[12px] font-normal text-gray-500">
        {label}
      </div>
      <div className="whitespace-nowrap text-[20px] text-gray-900">{value}</div>
      {sub && (
        <div className="whitespace-nowrap text-[12px] text-gray-500">{sub}</div>
      )}
    </div>
  );
}
