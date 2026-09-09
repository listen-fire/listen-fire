"use client";

/**
 * The five Formik wrappers behind the exit/realisation forms. Ported from
 * apps/app's AddDistribution/Form.tsx — initialValues, the guard clauses
 * and the mutation payload shaping are byte-faithful, because these are
 * the shapes the valuations engine books against.
 */

import type { ReactNode } from "react";
import { Formik } from "formik";

import { CurrencyIsoCode } from "#trpc";

import { useToast } from "@/components/portfolio";
import type { Company } from "@/components/portfolio/company/types";
import { trpc } from "@/lib/trpc";

import type {
  AcquisitionFormValues,
  DividendsFormValues,
  FundDistributionFormValues,
  LiquidationFormValues,
  SecondarySaleFormValues,
} from "./types";

export function AcquisitionForm({
  company,
  children,
  onClose,
}: {
  event?: unknown;
  company: Company;
  children: ReactNode;
  onClose: () => void;
}) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const { mutateAsync: addAcquisition } =
    trpc.views.portfolio.company.addAcquisition.useMutation({
      onSuccess: () => {
        utils.views.portfolio.company.invalidate();
        toast.success("Acquisition recorded");
        onClose();
      },
      onError: (error) => {
        toast.error(`Failed to record acquisition: ${error.message}`);
      },
    });

  return (
    <Formik<AcquisitionFormValues>
      enableReinitialize
      initialValues={{
        company: company,
        eventId: undefined,
        buyer: company?.acquirer
          ? {
              id: company.acquirer.id ?? "",
              name: company.acquirer.name ?? "",
              type: "FUND",
            }
          : undefined,
        valuation: undefined,
        currency: undefined, // Consider a default currency if applicable
        date: new Date().toISOString().split("T")[0],
        transactions: [],
      }}
      validateOnChange={false}
      validateOnBlur={true}
      onSubmit={async (values) => {
        if (!values.buyer || !values.date) {
          toast.error("Please fill in all required fields (Date, Buyer).");
          return;
        }

        if (values.eventId) {
          toast.error("Updating distributions is not yet supported");
        } else {
          addAcquisition({
            companyId: values.company?.id ?? "",
            acquirer: values.buyer,
            date: values.date,
            currency: values.currency,
            valuation: values.valuation,
            pricePerShare: values.pricePerShare,
            transactions: values.transactions,
          });
        }
      }}
    >
      {children}
    </Formik>
  );
}

export function SecondarySaleForm({
  company,
  children,
  onClose,
}: {
  company: Company;
  children: ReactNode;
  onClose: () => void;
}) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const { mutateAsync: addSecondarySale } =
    trpc.views.portfolio.company.addSecondarySale.useMutation({
      onSuccess: () => {
        utils.views.portfolio.company.invalidate();
        toast.success("Sale recorded");
        onClose();
      },
      onError: (error) => {
        toast.error(`Failed to record secondary sale: ${error.message}`);
      },
    });
  return (
    <Formik<SecondarySaleFormValues>
      enableReinitialize
      initialValues={{
        companyId: company?.id ?? "",
        transactions: [],
        date: new Date().toISOString().split("T")[0],
        buyer: undefined,
        currency: CurrencyIsoCode.GBP,
      }}
      validateOnChange={false}
      validateOnBlur={true}
      onSubmit={async (values) => {
        if (!values.buyer || !values.currency || !values.date) {
          toast.error(
            "Please fill in all required fields (Date, Buyer, Currency).",
          );
          return;
        }
        if (values.transactions.length === 0) {
          toast.error("Please add at least one transaction.");
          return;
        }

        const invalidTx = values.transactions.some(
          (tx) =>
            !tx.sellerId ||
            !tx.assetId ||
            tx.numAssets == null ||
            tx.pricePerShare == null ||
            tx.numAssets <= 0 ||
            tx.pricePerShare < 0,
        );
        if (invalidTx) {
          toast.error(
            "Please ensure all transaction details (Fund, Asset, Selling amount, Price per Share) are filled correctly.",
          );
          return;
        }

        addSecondarySale({
          companyId: values.companyId,
          transactions: values.transactions,
          buyer: values.buyer,
          date: values.date,
          currency: values.currency,
        });
      }}
    >
      {children}
    </Formik>
  );
}

export function DividendsForm({
  company,
  children,
  onClose,
}: {
  company: Company;
  children: ReactNode;
  onClose: () => void;
}) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const { mutateAsync: addDividends } =
    trpc.views.portfolio.company.addDividends.useMutation({
      onSuccess: () => {
        utils.views.portfolio.company.invalidate();
        toast.success("Dividend recorded");
        onClose();
      },
      onError: (error) => {
        toast.error(`Failed to record dividend: ${error.message}`);
      },
    });
  return (
    <Formik<DividendsFormValues>
      enableReinitialize
      initialValues={{
        company: company,
      }}
      validateOnChange={false}
      validateOnBlur={true}
      onSubmit={async (values) => {
        if (
          values.amount == null ||
          values.amount <= 0 ||
          !values.fundId ||
          !values.date ||
          !values.currency
        ) {
          toast.error(
            "Please fill in all required fields (Date, Amount, Fund, Currency).",
          );
          return;
        }

        addDividends({
          companyId: values.company?.id ?? "",
          date: values.date,
          amount: values.amount,
          fundId: values.fundId,
          currency: values.currency,
        });
      }}
    >
      {children}
    </Formik>
  );
}

export function FundDistributionForm({
  company,
  children,
  onClose,
}: {
  company: Company;
  children: ReactNode;
  onClose: () => void;
}) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const { mutateAsync: addFundDistribution } =
    trpc.views.portfolio.company.addFundDistribution.useMutation({
      onSuccess: () => {
        utils.views.portfolio.company.invalidate();
        toast.success("Fund distribution recorded");
        onClose();
      },
      onError: (error) => {
        toast.error(`Failed to record fund distribution: ${error.message}`);
      },
    });
  return (
    <Formik<FundDistributionFormValues>
      enableReinitialize
      initialValues={{
        company: company,
      }}
      validateOnChange={false}
      validateOnBlur={true}
      onSubmit={async (values) => {
        if (
          values.amount == null ||
          values.amount <= 0 ||
          !values.fundId ||
          !values.date ||
          !values.currency
        ) {
          toast.error(
            "Please fill in all required fields (Date, Amount, Fund, Currency).",
          );
          return;
        }

        addFundDistribution({
          companyId: values.company?.id ?? "",
          date: values.date,
          amount: values.amount,
          fundId: values.fundId,
          currency: values.currency,
        });
      }}
    >
      {children}
    </Formik>
  );
}

export function LiquidationForm({
  company,
  children,
  onClose,
}: {
  company: Company;
  children: ReactNode;
  onClose: () => void;
}) {
  const toast = useToast();
  const utils = trpc.useUtils();
  const { mutateAsync: addLiquidation } =
    trpc.views.portfolio.company.addLiquidation.useMutation({
      onSuccess: () => {
        utils.views.portfolio.company.invalidate();
        toast.success("Wind down recorded");
        onClose();
      },
      onError: (error) => {
        toast.error(`Failed to record wind down: ${error.message}`);
      },
    });

  return (
    <Formik<LiquidationFormValues>
      enableReinitialize
      initialValues={{
        company: company,
        date: new Date().toISOString().split("T")[0],
        transactions: [],
      }}
      validateOnChange={false}
      validateOnBlur={true}
      onSubmit={async (values) => {
        if (!values.date) {
          toast.error("Please fill in all required fields (Date, Cash Flows).");
          return;
        }

        addLiquidation({
          companyId: values.company?.id ?? "",
          date: values.date,
          transactions: values.transactions,
        });
      }}
    >
      {children}
    </Formik>
  );
}
