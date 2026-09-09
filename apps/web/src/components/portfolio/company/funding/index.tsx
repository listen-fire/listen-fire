"use client";

/**
 * Port of apps/app's FundingSection/index.tsx (V-20) — the company page's
 * funding history: the Add menu, the currency / "value as of" controls that
 * mirror into the querystring, the date-grouped event feed, and the
 * changelog.
 *
 * The querystring behaviour is the original's: `currency` is deleted when it
 * is USD, `valuationDate` is deleted when cleared, and a valuation date in
 * the past flags the view as historical. react-router's setSearchParams
 * becomes a Next router.replace on the current pathname.
 */

import { useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Banknote,
  Building2,
  ChevronDown,
  ChevronRight,
  CircleDollarSign,
  DollarSign,
  Handshake,
  Plus,
  ArrowRightLeft,
  Skull,
  Split,
  Tag as TagIcon,
  TrendingDown,
} from "lucide-react";

import { formatDate, useDisclosure } from "@/components/portfolio";
import { trpc } from "@/lib/trpc";

import { AddInvestment } from "@/components/portfolio/company/add-investment";
import { AddRound } from "@/components/portfolio/company/add-round";
import { AddMarkdown } from "@/components/portfolio/company/add-markdown";
import {
  AddAcquisition,
  AddDividends,
  AddFundDistribution,
  AddLiquidation,
  AddSecondarySale,
} from "@/components/portfolio/company/add-distribution";
import { InvestmentSummarySection } from "@/components/portfolio/company/investment-summary";

import type { Company } from "../types";

import { CurrencySelect } from "./common";
import { AddShareSplit, EventItem } from "./event-item";
import { AddPrice, PriceItem } from "./price-item";
import { InvestmentItem } from "./investment-item";
import { TransactionItem } from "./transaction-item";
import { AddFundDrawdown } from "./funds";

import { CurrencyIsoCode } from "#trpc";

export function FundingSection({ company }: { company: Company }) {
  const investmentDisclosure = useDisclosure();
  const markdownDisclosure = useDisclosure();
  const roundDisclosure = useDisclosure();
  const addPriceDisclosure = useDisclosure();
  const addShareSplitDisclosure = useDisclosure();
  const addAcquisitionDisclosure = useDisclosure();
  const addSecondarySaleDisclosure = useDisclosure();
  const addDividendsDisclosure = useDisclosure();
  const addLiquidationDisclosure = useDisclosure();
  const addFundDrawdownDisclosure = useDisclosure();
  const addFundDistributionDisclosure = useDisclosure();

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [currency, setCurrency] = useState<CurrencyIsoCode>(
    (searchParams.get("currency") as CurrencyIsoCode) || CurrencyIsoCode.USD,
  );
  const [valuationDate, setValuationDate] = useState<string | null>(
    searchParams.get("valuationDate"),
  );

  function writeParams(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, {
      scroll: false,
    });
  }

  function updateCurrency(value: CurrencyIsoCode | undefined) {
    const next = value ?? CurrencyIsoCode.USD;
    setCurrency(next);
    writeParams((params) => {
      if (next === CurrencyIsoCode.USD) {
        params.delete("currency");
      } else {
        params.set("currency", next);
      }
    });
  }

  function updateValuationDate(value: string | null) {
    setValuationDate(value);
    writeParams((params) => {
      if (value) {
        params.set("valuationDate", value);
      } else {
        params.delete("valuationDate");
      }
    });
  }

  const isHistorical =
    !!valuationDate && valuationDate < new Date().toISOString().slice(0, 10);

  const utils = trpc.useUtils();

  const { data } = trpc.views.portfolio.company.getInvestorsSummary.useQuery({
    legalEntityId: company?.id ?? "",
  });

  const events = useMemo(() => {
    return data?.rounds ?? [];
  }, [data]);

  if (events.length === 0) {
    return (
      <p className="text-[13px] text-gray-500">No funding history available</p>
    );
  }

  if (!company) {
    return null;
  }

  const isCompany =
    company.type === "COMPANY" || company.type === "PORTFOLIO_COMPANY";
  const isFund = company.type === "FUND";

  const closeAnd = (onClose: () => void) => () => {
    onClose();
    utils.views.portfolio.company.invalidate();
  };

  return (
    <div className="flex w-full flex-col items-stretch gap-8">
      <AddInvestment
        entity={{
          id: company.id,
          name: company.name,
          type: company.type ?? null,
        }}
        {...investmentDisclosure}
        onClose={closeAnd(investmentDisclosure.onClose)}
      />
      <AddMarkdown
        companyId={company.id}
        {...markdownDisclosure}
        onClose={closeAnd(markdownDisclosure.onClose)}
      />
      <AddRound
        entity={{
          id: company.id,
          name: company.name,
        }}
        {...roundDisclosure}
        onClose={closeAnd(roundDisclosure.onClose)}
      />
      <AddAcquisition
        company={company}
        {...addAcquisitionDisclosure}
        onClose={closeAnd(addAcquisitionDisclosure.onClose)}
      />
      <AddSecondarySale
        company={company}
        {...addSecondarySaleDisclosure}
        onClose={closeAnd(addSecondarySaleDisclosure.onClose)}
      />
      <AddDividends
        company={company}
        {...addDividendsDisclosure}
        onClose={closeAnd(addDividendsDisclosure.onClose)}
      />
      <AddLiquidation
        company={company}
        {...addLiquidationDisclosure}
        onClose={closeAnd(addLiquidationDisclosure.onClose)}
      />
      <AddFundDistribution
        company={company}
        {...addFundDistributionDisclosure}
        onClose={closeAnd(addFundDistributionDisclosure.onClose)}
      />
      <AddShareSplit
        companyId={company.id}
        disclosure={addShareSplitDisclosure}
      />
      <AddPrice companyId={company.id} disclosure={addPriceDisclosure} />
      <AddFundDrawdown
        fundId={company.id}
        disclosure={addFundDrawdownDisclosure}
      />

      <div className="flex w-full flex-col items-stretch">
        {company.investments && company.investments.length > 0 ? (
          <InvestmentSummarySection company={company} currency={currency} />
        ) : null}
        <div className="h-4" />
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-[24px] font-medium text-black">History</h2>
            {isHistorical && (
              <span className="text-[13px] font-medium text-orange-500">
                Viewing as of{" "}
                {formatDate(new Date(valuationDate!), "MMM d, yyyy")}
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="w-[120px]">
              <CurrencySelect value={currency} onChange={updateCurrency} />
            </div>
            <input
              type="date"
              value={valuationDate ?? ""}
              onChange={(e) => updateValuationDate(e.target.value || null)}
              className={`h-8 w-[150px] rounded-md border border-gray-200 px-2 py-1 text-[13px] focus:outline-none ${
                valuationDate ? "text-gray-600" : "text-gray-400"
              }`}
            />
            <AddMenu
              isCompany={isCompany}
              isFund={isFund}
              items={{
                investment: investmentDisclosure.onOpen,
                round: roundDisclosure.onOpen,
                acquisition: addAcquisitionDisclosure.onOpen,
                secondarySale: addSecondarySaleDisclosure.onOpen,
                dividends: addDividendsDisclosure.onOpen,
                windDown: addLiquidationDisclosure.onOpen,
                price: addPriceDisclosure.onOpen,
                markdown: markdownDisclosure.onOpen,
                shareSplit: addShareSplitDisclosure.onOpen,
                fundDrawdown: addFundDrawdownDisclosure.onOpen,
                fundDistribution: addFundDistributionDisclosure.onOpen,
              }}
            />
          </div>
        </div>
        <div className="h-1" />
        <EventHistory
          companyId={company.id}
          companyType={company.type}
          currency={currency}
          valuationDate={valuationDate}
        />
        <FundingChangelog companyId={company.id} />
      </div>
    </div>
  );
}

function AddMenu({
  isCompany,
  isFund,
  items,
}: {
  isCompany: boolean;
  isFund: boolean;
  items: Record<string, () => void>;
}) {
  const [open, setOpen] = useState(false);

  const entries = [
    { key: "investment", label: "Investment", icon: <Handshake />, show: true },
    { key: "round", label: "Round", icon: <DollarSign />, show: isCompany },
    {
      key: "acquisition",
      label: "Acquisition",
      icon: <Building2 />,
      show: true,
    },
    {
      key: "secondarySale",
      label: "Secondary Sale",
      icon: <ArrowRightLeft />,
      show: true,
    },
    {
      key: "dividends",
      label: "Dividends",
      icon: <Banknote />,
      show: isCompany,
    },
    { key: "windDown", label: "Wind Down", icon: <Skull />, show: true },
    { key: "price", label: "Price", icon: <TagIcon />, show: true },
    {
      key: "markdown",
      label: "Markdown",
      icon: <TrendingDown />,
      show: true,
    },
    {
      key: "shareSplit",
      label: "Share Split",
      icon: <Split />,
      show: isCompany,
    },
    {
      key: "fundDrawdown",
      label: "Fund Drawdown",
      icon: <CircleDollarSign />,
      show: isFund,
    },
    {
      key: "fundDistribution",
      label: "Fund Distribution",
      icon: <CircleDollarSign />,
      show: isFund,
    },
  ].filter((entry) => entry.show);

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 items-center gap-1 rounded-lg bg-primary px-3 text-[13px] font-medium text-white hover:bg-primary-600"
      >
        <Plus className="h-5 w-5" />
        Add
        <ChevronDown className="h-4 w-4" />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-[1000] mt-1 min-w-[200px] overflow-hidden rounded-lg border border-gray-200 bg-white shadow-lg">
          {entries.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => {
                setOpen(false);
                items[entry.key]?.();
              }}
              className="flex w-full items-center gap-3 px-3 py-3 text-left text-[13px] text-gray-700 hover:bg-gray-50 [&_svg]:h-4 [&_svg]:w-4"
            >
              {entry.icon}
              {entry.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EventHistory({
  companyId,
  companyType,
  currency = CurrencyIsoCode.USD,
  valuationDate,
}: {
  companyId: string;
  companyType: Exclude<Company, null>["type"];
  currency?: CurrencyIsoCode;
  valuationDate?: string | null;
}) {
  const { data } = trpc.views.portfolio.company.getEventHistory.useQuery({
    companyId,
    config: {
      currency,
      valuationDate: valuationDate
        ? new Date(valuationDate).toISOString()
        : undefined,
    },
  });

  const dates = new Set<string | null>();
  for (const event of data?.events ?? []) {
    dates.add(event.date);
  }
  for (const transaction of data?.transactions ?? []) {
    dates.add(transaction.date);
  }
  for (const price of data?.prices ?? []) {
    dates.add(price.date);
  }
  for (const investment of data?.investments ?? []) {
    dates.add(investment.date);
  }

  const sortedDates = Array.from(dates).sort((a, b) => {
    // sort nulls last
    if (a === null) {
      return 1;
    }
    if (b === null) {
      return -1;
    }
    return new Date(b).getTime() - new Date(a).getTime();
  });

  const itemsByDate = sortedDates.map((date) => {
    return {
      date,
      events: data?.events?.filter((event) => event.date === date) ?? [],
      transactions:
        data?.transactions?.filter(
          (transaction) => transaction.date === date,
        ) ?? [],
      prices: data?.prices?.filter((price) => price.date === date) ?? [],
      investments:
        data?.investments?.filter((investment) => investment.date === date) ??
        [],
    };
  });

  return (
    <div className="my-5 flex w-full flex-col items-stretch gap-10">
      {itemsByDate.map((item) => {
        return (
          <div
            key={String(item.date)}
            className="flex flex-col items-stretch gap-4"
          >
            {!item.date ? (
              <span className="text-[18px] font-medium text-black">
                Unknown Date
              </span>
            ) : (
              <div className="flex items-baseline gap-2">
                <span className="text-[18px] font-semibold text-black">
                  {formatDate(new Date(item.date), "yyyy")}
                </span>
                <span className="text-[14px] font-medium text-black">
                  {formatDate(new Date(item.date), "MMMM do")}
                </span>
              </div>
            )}
            <div className="flex flex-col items-stretch gap-4">
              {item.events.map((event) => (
                <EventItem key={event.id} event={event} companyId={companyId} />
              ))}
              {item.investments.map((investment) => (
                <InvestmentItem
                  key={investment.id}
                  investment={investment}
                  currency={currency}
                  companyId={companyId}
                  convertibleAssets={data?.convertibleAssets ?? {}}
                />
              ))}
              {item.transactions.map((transaction) => (
                <TransactionItem
                  key={transaction.transactionId}
                  transaction={transaction}
                  companyType={companyType}
                  companyId={companyId}
                />
              ))}
              {item.prices.map((price) => (
                <PriceItem key={price.id} price={price} />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function FundingChangelog({ companyId }: { companyId: string }) {
  const [isOpen, setIsOpen] = useState(false);
  const { data } = trpc.views.portfolio.company.getFundingChangelog.useQuery(
    { legalEntityId: companyId },
    { enabled: isOpen },
  );

  return (
    <div className="mt-10 flex flex-col items-stretch">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        className="flex items-baseline gap-2 py-2 text-left"
      >
        <ChevronRight
          className={`h-4 w-4 transition-transform duration-150 ${isOpen ? "rotate-90" : ""}`}
        />
        <span className="text-[16px] font-medium text-gray-600">Changelog</span>
        {data?.length ? (
          <span className="text-[13px] text-gray-400">
            {data.length} {data.length === 1 ? "entry" : "entries"}
          </span>
        ) : null}
      </button>
      {isOpen ? (
        <div className="flex flex-col items-stretch py-2">
          {data?.length === 0 && (
            <span className="py-2 text-[13px] text-gray-400">
              No changes recorded yet
            </span>
          )}
          {data?.map((entry) => (
            <div
              key={entry.id}
              className="flex items-baseline gap-3 border-b border-gray-100 px-1 py-1.5"
            >
              <span className="w-[140px] shrink-0 text-[13px] text-gray-400">
                {formatDate(new Date(entry.created_at), "MMM d, yyyy HH:mm")}
              </span>
              <span className="flex-1 whitespace-pre-wrap text-[13px] text-gray-600">
                {entry.description}
              </span>
              {entry.event_date ? (
                <span className="shrink-0 text-[12px] text-gray-400">
                  effective{" "}
                  {formatDate(new Date(entry.event_date), "MMM d, yyyy")}
                </span>
              ) : null}
              {entry.username && (
                <span className="shrink-0 text-[12px] text-gray-400">
                  {entry.username}
                </span>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
