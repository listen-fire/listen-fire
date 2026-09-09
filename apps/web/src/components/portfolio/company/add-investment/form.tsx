"use client";

import { Formik, type FormikProps } from "formik";
import { createContext, useContext, type ReactNode } from "react";

import { trpc } from "@/lib/trpc";
import { useToast } from "@/components/portfolio";

import type { FormValues } from "./types";

import { LegalEntityType, CurrencyIsoCode, ValuationType } from "#trpc";

const defaultCurrency = CurrencyIsoCode.EUR;

const FormMetadataContext = createContext<{ isEntityNameReadOnly: boolean }>({
  isEntityNameReadOnly: false,
});

export function useFormMetadata() {
  return useContext(FormMetadataContext);
}

export function AddInvestmentForm({
  entity,
  children,
  onClose,
}: {
  entity?: {
    id: string;
    name: string;
    type: LegalEntityType | null;
  } | null;
  children: ReactNode | ((props: FormikProps<FormValues>) => ReactNode);
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const toast = useToast();
  const { mutateAsync: addInvestment } =
    trpc.views.portfolio.company.addInvestment.useMutation();
  const isEntityNameReadOnly = Boolean(entity?.name);
  return (
    <Formik<FormValues>
      initialValues={{
        investmentCurrency: defaultCurrency,
        pricePerShareCurrency: defaultCurrency,
        valuationCurrency: defaultCurrency,
        totalRaisedCurrency: defaultCurrency,
        valuationType: ValuationType.POST_MONEY,
        entity: entity?.id,
        entityName: entity?.name,
        entityType: entity?.type ?? undefined,
      }}
      onSubmit={async (values) => {
        try {
          await addInvestment({
            entity: values["entity"]!,
            entityName: values["entityName"],
            entityType: values["entityType"],
            entityWebsite: values["entityWebsite"],
            investmentType: values["investmentType"]!,
            investingEntity: values["investingEntity"]!,
            investingEntityName: values["investingEntityName"]!,
            roundName: values["roundName"]!,
            committedAmount: values["committedAmount"],
            committedCurrency: values["committedCurrency"],
            investmentCurrency: values["investmentCurrency"]!,
            pricePerShareCurrency: values["pricePerShareCurrency"],
            valuationCurrency: values["valuationCurrency"],
            totalRaisedCurrency: values["totalRaisedCurrency"],
            valuationType: values["valuationType"],
            investmentAmount: values["investmentAmount"]!,
            pricePerShare: values["pricePerShare"],
            numberOfShares: values["numberOfShares"],
            shareClass: values["shareClass"],
            investmentDate: values["investmentDate"]!,
            valuationAmount: values["valuationAmount"],
            totalRaisedAmount: values["totalRaisedAmount"],
            convertibleType: values["convertibleType"],
            convertibleName: values["convertibleName"],
            convertibleValuationCap: values["convertibleValuationCap"],
            convertibleMaturityDate: values["convertibleMaturityDate"],
            convertibleInterestRate: values["convertibleInterestRate"],
            convertibleDiscountRate: values["convertibleDiscountRate"],
            spv: values["spv"],
            spvName: values["spvName"],
            seller: values["seller"],
            sellerName: values["sellerName"],
            coInvestors: values["coInvestors"],
          });
        } catch (error) {
          toast.error(
            error instanceof Error ? error.message : "Could not add investment",
          );
          return;
        }
        await Promise.all([
          utils.views.portfolio.company.invalidate(),
          utils.views.investments.getPortfolioInvestments.invalidate(),
        ]);
        toast.success("Investment added");
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
