"use client";

import { Formik, type FormikProps } from "formik";
import { createContext, type ReactNode } from "react";

import { trpc } from "@/lib/trpc";
import { useToast } from "@/components/portfolio";

import type { FormValues } from "./types";

import { CurrencyIsoCode, ValuationType } from "#trpc";

const defaultCurrency = CurrencyIsoCode.EUR;

const FormMetadataContext = createContext<{ isEntityNameReadOnly: boolean }>({
  isEntityNameReadOnly: false,
});

export function AddRoundForm({
  entity,
  children,
  onClose,
}: {
  entity?: {
    id: string;
    name: string;
  } | null;
  children: ReactNode | ((props: FormikProps<FormValues>) => ReactNode);
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const { mutateAsync: addRound } =
    trpc.views.portfolio.company.addRound.useMutation();
  const isEntityNameReadOnly = Boolean(entity?.name);
  return (
    <Formik<FormValues>
      initialValues={{
        currency: defaultCurrency,
        valuationType: ValuationType.POST_MONEY,
        entity: entity?.id,
      }}
      onSubmit={async (values) => {
        try {
          await addRound({
            entity: values["entity"]!,
            roundName: values["roundName"]!,
            date: values["date"]!,
            currency: values["currency"]!,
            pricePerShare: values["pricePerShare"],
            valuationAmount: values["valuationAmount"],
            valuationType: values["valuationType"],
            totalRaisedAmount: values["totalRaisedAmount"],
            coInvestors: values["coInvestors"],
          });
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Could not add round",
          );
          return;
        }
        await Promise.all([
          utils.views.portfolio.company.invalidate(),
          utils.views.investments.getPortfolioInvestments.invalidate(),
        ]);
        toast.success("Round added");
        onClose();
      }}
    >
      {(formikProps) => (
        <FormMetadataContext.Provider value={{ isEntityNameReadOnly }}>
          {typeof children === "function" ? children(formikProps) : children}
        </FormMetadataContext.Provider>
      )}
    </Formik>
  );
}
