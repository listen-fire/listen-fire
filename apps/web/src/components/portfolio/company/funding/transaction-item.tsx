"use client";

/**
 * Port of apps/app's FundingSection/TransactionItem.tsx (V-20). The
 * classification branching — conversion, legacy share split, fund drawdown,
 * fallback — is copied unchanged; only the chrome is Tailwind now. The
 * attachments block is gone with `getEventHistory`'s resources.
 */

import { useMemo } from "react";
import { CircleDollarSign, DollarSign, Split, ArrowLeftRight } from "lucide-react";

import { trpc } from "@/lib/trpc";

import type { Company } from "../types";

import { AssetTypeMap, HistoryItemBox, NotesSection } from "./common";
import type { Transaction } from "./types";

import { AssetType } from "#trpc";

function TransactionItem({
  transaction,
  companyType,
  companyId: _companyId,
}: {
  transaction: Transaction;
  companyType: Exclude<Company, null>["type"];
  companyId: string;
}) {
  const utils = trpc.useUtils();
  const { mutateAsync: addNote } =
    trpc.views.portfolio.company.addTransactionNote.useMutation();

  const expandedContent = useMemo(() => {
    return (
      <NotesSection
        notes={transaction.notes}
        onAdd={async (text) => {
          await addNote({ transactionId: transaction.transactionId, note: text });
          utils.views.portfolio.company.invalidate();
        }}
      />
    );
  }, [transaction, addNote, utils]);

  const relatedNumbers = useMemo(() => {
    return {
      attachments: null,
      notes: transaction.notes?.length ?? 0,
      coinvestors: null,
    };
  }, [transaction]);

  if (transaction.classification === "ASSET_EXCHANGE") {
    const convertibleItem = transaction.outflows.find(
      (outflow) => outflow.assetType === "CONVERTIBLE",
    );
    const equityItem = transaction.inflows.find(
      (inflow) => inflow.assetType === "EQUITY",
    );

    if (convertibleItem && equityItem) {
      return (
        <HistoryItemBox
          key={transaction.transactionId}
          title={{
            icon: <ArrowLeftRight />,
            title: "Conversion",
          }}
          infoLine={
            <span className="text-[13px] text-gray-400">
              {convertibleItem.numAssets} {convertibleItem.assetName} (
              {AssetTypeMap[convertibleItem.assetType as AssetType]}) for{" "}
              {equityItem.numAssets} {equityItem.assetName} (
              {AssetTypeMap[equityItem.assetType as AssetType]})
            </span>
          }
          expandedContent={expandedContent}
          relatedNumbers={relatedNumbers}
        />
      );
    }
  }
  if (
    transaction.classification === "ONE_WAY_TRANSACTION" &&
    transaction.inflows.some((inflow) => inflow.assetType === "EQUITY")
  ) {
    const equityItem = transaction.inflows.find(
      (inflow) => inflow.assetType === "EQUITY",
    );

    return (
      <HistoryItemBox
        key={transaction.transactionId}
        title={{
          icon: <Split />,
          title: "Share Split",
          tags: [
            <span
              key="legacy"
              className="inline-flex shrink-0 items-center rounded-[3px] border border-gray-200 bg-white px-2 py-0.5 font-mono text-[11px] text-gray-500"
            >
              Legacy
            </span>,
          ],
        }}
        infoLine={
          <span className="text-[13px] text-gray-400">
            Received {equityItem?.numAssets} {equityItem?.assetName} (
            {AssetTypeMap[equityItem?.assetType as AssetType]})
          </span>
        }
        actions={null}
        relatedNumbers={relatedNumbers}
        expandedContent={expandedContent}
      />
    );
  }

  if (
    transaction.classification === "ONE_WAY_TRANSACTION" &&
    transaction.outflows.length === 1 &&
    companyType === "FUND"
  ) {
    return (
      <HistoryItemBox
        key={transaction.transactionId}
        title={{
          icon: <CircleDollarSign />,
          title: "Drawdown",
        }}
        infoLine={
          <span className="text-[13px] text-gray-400">
            {transaction.outflows[0].numAssets}{" "}
            {transaction.outflows[0].assetName}
          </span>
        }
        actions={null}
        relatedNumbers={relatedNumbers}
        expandedContent={expandedContent}
      />
    );
  }

  return (
    <HistoryItemBox
      key={transaction.transactionId}
      title={{
        icon: <DollarSign />,
        title: "Transaction",
      }}
      infoLine={
        <span className="text-[13px]">{transaction.classification}</span>
      }
      actions={null}
      relatedNumbers={relatedNumbers}
      expandedContent={expandedContent}
    />
  );
}

export { TransactionItem };
