"use client";

/**
 * Port of apps/app's FundingSection/InvestmentItem.tsx (V-20). Every derived
 * value — which transactions count as "received on the investment date",
 * whether a convertible is still unconverted, which outflow carries the cash
 * paid, and the Invested/Retained/Realized/MOIC tiles — is copied verbatim;
 * these decide what the user believes they own.
 *
 * lodash's uniq/uniqBy are inlined (apps/web does not depend on lodash), and
 * the attachments block is gone with `getEventHistory`'s resources.
 */

import { ArrowLeftRight, Handshake } from "lucide-react";
import Link from "next/link";

import { FormModal, formatMoney, formatDate, useDisclosure } from "@/components/portfolio";
import { trpc } from "@/lib/trpc";

import { ConvertTransaction } from "@/components/portfolio/company/convert-convertible";
import { EditTransaction } from "@/components/portfolio/company/edit-transaction";

import {
  AssetTypeColorMap,
  AssetTypeMap,
  HistoryItemBox,
  HistoryMoreButton,
  NotesSection,
  Tag,
} from "./common";
import type { ConvertibleAssetDetails, Investment } from "./types";

import { AssetType, CurrencyIsoCode } from "#trpc";

type ProcessMessage = Exclude<Investment["message"], undefined | null>[number];

function notNull<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function uniq<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function InvestmentItem({
  investment,
  currency,
  companyId: _companyId,
  convertibleAssets,
}: {
  investment: Investment;
  currency: CurrencyIsoCode;
  companyId: string;
  convertibleAssets: Record<string, ConvertibleAssetDetails>;
}) {
  const { isOpen, onOpen, onClose } = useDisclosure();
  const utils = trpc.useUtils();
  const { mutateAsync: addNote } =
    trpc.views.portfolio.company.addInvestmentNote.useMutation();

  const assetsReceived = investment.transactions
    .filter((transaction) => transaction.date === investment.date)
    .flatMap((transaction) =>
      transaction.inflows.map((inflow) => inflow.assetType as AssetType),
    );

  const isConvertible = investment.transactions.some((transaction) =>
    transaction.inflows.some((inflow) => inflow.assetType === "CONVERTIBLE"),
  );
  const convertibleInflow = investment.transactions
    .flatMap((transaction) => transaction.inflows)
    .find((inflow) => inflow.assetType === "CONVERTIBLE");
  const unconvertedTransaction = investment.transactions.find(
    (transaction) =>
      transaction.inflows.some((inflow) => inflow.assetType === "CONVERTIBLE") &&
      !transaction.convertedToId,
  );
  const convertibleAssetCurrency = unconvertedTransaction?.outflows.find(
    (outflow) => outflow.assetType === "CURRENCY",
  )?.assetName as CurrencyIsoCode | undefined;
  const convertibleAssetPaid = unconvertedTransaction?.outflows.find(
    (outflow) => outflow.assetType === "CURRENCY",
  )?.numAssets;
  const convertDisclosure = useDisclosure();
  const editDisclosure = useDisclosure();

  const menuItems = [
    /*{
      label: 'Edit',
      icon: <Pencil />,
      onClick: () => {
        editDisclosure.onOpen();
      },
    }*/ null,
    unconvertedTransaction
      ? {
          label: "Convert",
          icon: <ArrowLeftRight />,
          onClick: () => {
            convertDisclosure.onOpen();
          },
        }
      : null,
  ].filter(notNull);

  return (
    <HistoryItemBox
      key={investment.id}
      colourHue={200}
      title={{
        icon: <Handshake />,
        title: "Investment",
        tags:
          investment.eventType === "DISTRIBUTION"
            ? [
                <Link
                  key="distribution"
                  href={`/portfolio/c/${investment.eventLegalEntitySlug}`}
                  className="inline-flex shrink-0 items-center rounded border border-violet-200 bg-violet-50 px-2 py-1 text-[12px] text-violet-600"
                >
                  Acquisition: {investment.eventLegalEntityName}
                </Link>,
              ]
            : uniq(assetsReceived).map((asset) => (
                <Tag key={asset} colour={AssetTypeColorMap[asset]}>
                  {AssetTypeMap[asset]}
                </Tag>
              )),
      }}
      stats={
        <div
          onClick={onOpen}
          className="grid cursor-pointer grid-cols-2 gap-x-10 gap-y-4 hover:opacity-80 sm:grid-cols-4"
        >
          <div className="flex flex-col items-start gap-0.5">
            <span className="text-[12px] font-medium text-gray-500">
              Invested
            </span>
            <span className="text-[14px] font-medium">
              {formatMoney(investment.totalInvested, {
                currency: currency,
                isAbbrFormat: true,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>

          <div className="flex flex-col items-start gap-0.5">
            <span className="text-[12px] font-medium text-gray-500">
              Retained
            </span>
            <span className="text-[14px] font-medium">
              {formatMoney(investment.unrealizedValue, {
                currency: currency,
                isAbbrFormat: true,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>

          <div className="flex flex-col items-start gap-0.5">
            <span className="text-[12px] font-medium text-gray-500">
              Realized
            </span>
            <span className="text-[14px] font-medium">
              {formatMoney(investment.realizedValue, {
                currency: currency,
                isAbbrFormat: true,
                maximumFractionDigits: 2,
              })}
            </span>
          </div>

          <div className="flex flex-col items-start gap-0.5">
            <span className="text-[12px] font-medium text-gray-500">MOIC</span>
            <span className="text-[14px] font-medium">
              {investment.moic ? investment.moic.toFixed(2) + "x" : "-"}
            </span>
          </div>

          <FormModal
            isOpen={isOpen}
            onClose={onClose}
            size="xl"
            title="Investment Calculation Details"
          >
            <div className="flex flex-col items-stretch gap-2">
              {investment.message?.map((msg, i) => (
                <MessageRenderer key={i} message={msg} />
              ))}
            </div>
          </FormModal>
        </div>
      }
      infoLine={
        <span className="text-[13px] text-gray-400">
          {uniq(
            investment.transactions.map(
              (transaction) => transaction.investingEntityKey.split(":")[1],
            ),
          ).join(", ")}
        </span>
      }
      actions={
        <div className="flex items-center gap-2">
          {unconvertedTransaction ? (
            <ConvertTransaction
              transactionId={unconvertedTransaction.transactionId}
              assetId={convertibleInflow?.assetId ?? ""}
              originalAmount={convertibleAssetPaid?.toString() ?? ""}
              currency={convertibleAssetCurrency ?? "USD"}
              {...convertDisclosure}
              onClose={() => {
                convertDisclosure.onClose();
                utils.views.portfolio.company.invalidate();
              }}
            />
          ) : null}
          {investment.transactions.length > 0 ? (
            <EditTransaction
              values={{
                transaction: {
                  id: investment.transactions[0].transactionId,
                  date: investment.transactions[0].date,
                },
                transfers: [
                  /* TODO */
                ],
              }}
              {...editDisclosure}
              onClose={() => {
                editDisclosure.onClose();
                utils.views.portfolio.company.invalidate();
              }}
            />
          ) : null}
          {menuItems.length > 0 ? (
            <HistoryMoreButton menuItems={menuItems} />
          ) : null}
        </div>
      }
      expandedContent={
        <div className="flex flex-col items-stretch gap-5">
          <div className="flex flex-col items-stretch gap-2">
            <span className="text-[16px] font-semibold">Details</span>
            <ConvertibleDetails
              details={
                convertibleInflow
                  ? convertibleAssets[convertibleInflow.assetId]
                  : undefined
              }
              fallbackCurrency={currency}
            />
          </div>
          <NotesSection
            notes={investment.notes}
            onAdd={async (text) => {
              await addNote({ investmentId: investment.id, note: text });
              utils.views.portfolio.company.invalidate();
            }}
          />
        </div>
      }
      relatedNumbers={{
        attachments: null,
        notes: investment.notes?.length ?? 0,
        coinvestors: null,
        details: isConvertible,
      }}
    />
  );
}

function ConvertibleDetails({
  details,
  fallbackCurrency,
}: {
  details: ConvertibleAssetDetails | undefined;
  fallbackCurrency: CurrencyIsoCode;
}) {
  if (!details) {
    return <span className="text-[13px] text-gray-400">No details recorded.</span>;
  }

  const moneyCurrency = details.convertibleCurrency ?? fallbackCurrency;
  const formatMoneyValue = (value: number | null) =>
    value === null ? null : formatMoney(value, { currency: moneyCurrency });
  const formatRate = (value: number | null) =>
    value === null ? null : `${value}%`;
  const formatDay = (value: Date | string | null) =>
    value === null ? null : formatDate(new Date(value), "d MMM yyyy");

  const rows: Array<{ label: string; value: React.ReactNode | null }> = [
    { label: "Type", value: details.convertibleType },
    { label: "Amount", value: formatMoneyValue(details.convertibleAmount) },
    { label: "Issued", value: formatDay(details.issuedAt) },
    { label: "Maturity", value: formatDay(details.maturityDate) },
    { label: "Valuation cap", value: formatMoneyValue(details.valuationCap) },
    { label: "Discount", value: formatRate(details.discountRate) },
    {
      label: "Interest rate",
      value: formatRate(details.annualisedInterestRate),
    },
    { label: "Conversion date", value: formatDay(details.conversionDate) },
    {
      label: "Conversion price",
      value: formatMoneyValue(details.conversionPrice),
    },
    { label: "Accrued interest", value: formatMoneyValue(details.interest) },
  ].filter(
    (row) => row.value !== null && row.value !== undefined && row.value !== "",
  );

  if (rows.length === 0) {
    return <span className="text-[13px] text-gray-400">No details recorded.</span>;
  }

  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-1.5 sm:grid-cols-2">
      {rows.map((row) => (
        <div
          key={row.label}
          className="flex items-center justify-between gap-5"
        >
          <span className="text-[14px] text-gray-400">{row.label}</span>
          <span className="text-right text-[14px] font-medium">
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * Port of apps/app's PortfolioList/Investments.tsx MessageRenderer — the
 * calculation trace the "Investment Calculation Details" modal renders.
 */
function MessageRenderer({ message }: { message: ProcessMessage }) {
  if (message.type === "header") {
    return (
      <p className="mb-2 mt-4 text-[16px] font-bold">
        {message.content as string}
      </p>
    );
  } else if (message.type === "table") {
    const tableContent = message.content;
    return (
      <div className="my-4 overflow-x-auto">
        <table className="w-full text-[12px]">
          <thead>
            <tr>
              {tableContent.headers.map((header, i) => (
                <th
                  key={i}
                  className="border-b border-gray-200 px-2 py-1 text-left font-medium text-gray-500"
                >
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tableContent.rows.map((row, i) => (
              <tr key={i}>
                {row.map((cell, j) => (
                  <td
                    key={j}
                    className="whitespace-pre-wrap border-b border-gray-100 px-2 py-1"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else {
    return (
      <p className="whitespace-pre-wrap font-mono text-[12px]">
        {message.content as string}
      </p>
    );
  }
}

export { InvestmentItem };
