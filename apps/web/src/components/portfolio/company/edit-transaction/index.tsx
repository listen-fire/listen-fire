"use client";

/**
 * Port of apps/app's Portfolio/Profile/EditTransaction/ — edits the asset
 * transfers that make up one transaction (cash legs, share legs, convertible
 * terms, and post-conversion details). Which fields a leg shows is driven by
 * its asset type and whether it has been converted; that branching and the
 * submit payload shaping are carried over unchanged.
 */

import { useEffect, useMemo, useState } from "react";
import { Formik, Form as FormikForm, useFormikContext } from "formik";
import { format } from "date-fns";
import { Building2, Calendar, Coins, Landmark, Package } from "lucide-react";

import { trpc } from "@/lib/trpc";
import {
  Field,
  FormFooter,
  FormModal,
  FormSelect,
  FutureDateWarning,
  TextInput,
  convertUnderscore,
  currencies,
  formatNumber,
  useToast,
} from "@/components/portfolio";
import { AssetType, ConvertibleType, CurrencyIsoCode } from "#trpc";

type FormValues = { transaction: Transaction; transfers: AssetTransfer[] };

type Transaction = {
  id: string;
  date: string;
};

type AssetTransfer = {
  type: AssetType;
  numAssets?: string | null;
  id: string;
  currency?: string | null;
  assetId: string;
  assetName: string;
  fundName: string;
  fundId: string;
  // conversion details
  converted: boolean;
  convertibleAssetId?: string | null;
  conversionPrice?: string | null;
  interestAmount?: string | null;
  interestRate?: string | null;
  discountRate?: string | null;
  maturityDate?: string | null;
  valuationCap?: string | null;
  valuationCapCurrency?: string | null;
  convertibleType?: ConvertibleType | null;
};

const currencyOptions = currencies.map((currency) => ({
  label: currency,
  value: currency,
}));

const convertibles = [
  ConvertibleType.ASA,
  ConvertibleType.BSA_AIR,
  ConvertibleType.CONVERTIBLE_NOTE,
  ConvertibleType.LOAN,
  ConvertibleType.POST_MONEY_SAFE,
  ConvertibleType.PRE_MONEY_SAFE,
  ConvertibleType.SAFT,
  ConvertibleType.SEEDFAST,
  ConvertibleType.SEEDNOTE,
  ConvertibleType.SLIP,
] as const;

type EnsureAllConvertibles<T extends readonly ConvertibleType[]> =
  Exclude<ConvertibleType, T[number]> extends never ? T : never;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const checkedConvertibles: EnsureAllConvertibles<typeof convertibles> =
  convertibles;

const convertibleOptions = convertibles.map((name) => ({
  label: convertUnderscore(name),
  value: name,
}));

function EditTransaction({
  values,
  isOpen,
  onClose,
}: {
  values: FormValues;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const sorted = values.transfers.toReversed();
  return (
    <EditTransactionForm
      transaction={values.transaction}
      transfers={sorted}
      onClose={onClose}
    >
      <>
        <ResetFormOnClose isOpen={isOpen} />
        <FormikForm>
          <FormModal
            isOpen={isOpen}
            onClose={onClose}
            title="Edit Transaction"
            size="xl"
            footer={<Footer onCancel={onClose} />}
          >
            <Body />
          </FormModal>
        </FormikForm>
      </>
    </EditTransactionForm>
  );
}

function EditTransactionForm({
  transaction,
  transfers,
  children,
  onClose,
}: {
  transaction: Transaction;
  transfers: AssetTransfer[];
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { mutateAsync: updateAssetTransfer } =
    trpc.views.portfolio.company.updateAssetTransfer.useMutation();
  const utils = trpc.useUtils();
  const toast = useToast();

  return (
    <Formik<FormValues>
      enableReinitialize
      initialValues={{
        transaction: transaction,
        transfers: transfers,
      }}
      validateOnChange={true}
      onSubmit={async (values) => {
        await updateAssetTransfer(
          values.transfers.map((tx) => {
            return {
              transferId: tx.id,
              numAssets: tx.numAssets ?? undefined,
              assetName: tx.assetName ?? undefined,
              assetId: tx.assetId,
              type: tx.type,
              date: values.transaction.date,
              currency: tx.currency as CurrencyIsoCode,
              ...(tx.type === "CONVERTIBLE"
                ? {
                    conversionPrice: tx.conversionPrice ?? undefined,
                    convertibleAssetId: tx.convertibleAssetId ?? undefined,
                    maturityDate: tx.maturityDate ?? undefined,
                    discountRate: tx.discountRate ?? undefined,
                    interestRate: tx.interestRate ?? undefined,
                    valuationCap: tx.valuationCap ?? undefined,
                    valuationCapCurrency:
                      (tx.valuationCapCurrency as CurrencyIsoCode) ?? undefined,
                    convertibleType: tx.convertibleType ?? undefined,
                  }
                : {}),
              ...(tx.converted
                ? {
                    convertibleAssetId: tx.convertibleAssetId ?? undefined,
                    conversionPrice: tx.conversionPrice ?? undefined,
                    interestAmount: tx.interestAmount ?? undefined,
                  }
                : {}),
            };
          }),
        );
        await utils.views.portfolio.company.invalidate();
        toast.success("Transaction updated");
        onClose();
      }}
    >
      {children}
    </Formik>
  );
}

function ResetFormOnClose({ isOpen }: { isOpen: boolean }) {
  const { resetForm } = useFormikContext();

  useEffect(() => {
    if (!isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  return null;
}

function Footer({ onCancel }: { onCancel: () => void }) {
  const { isSubmitting } = useFormikContext<FormValues>();

  return <FormFooter onCancel={onCancel} isSubmitting={isSubmitting} />;
}

function Body() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const handleChange = (
    field: string,
    index: number,
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const numericValue = e.target.value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    const updatedTransactions = [...values.transfers];
    updatedTransactions[index] = {
      ...updatedTransactions[index],
      [field]: numericValue,
    };
    setFieldValue("transfers", updatedTransactions);
  };

  return (
    <div className="flex w-full flex-col items-stretch">
      <div className="grid w-full grid-cols-3 gap-4 pb-6">
        <Field
          label="Date"
          icon={<Calendar className="h-4 w-4 text-gray-400" />}
          required
        >
          <TextInput
            type="date"
            value={
              values.transaction.date
                ? format(new Date(values.transaction.date), "yyyy-MM-dd")
                : ""
            }
            onChange={(e) => {
              const updatedTransactions = {
                ...values.transaction,
                date: e.target.value,
              };
              setFieldValue("transaction", updatedTransactions);
            }}
          />
          <FutureDateWarning
            value={
              values.transaction.date
                ? format(new Date(values.transaction.date), "yyyy-MM-dd")
                : ""
            }
          />
        </Field>
      </div>

      {values.transfers.map((tx, idx) => (
        <div
          key={tx.id}
          className="grid w-full grid-cols-3 gap-4 border-t border-gray-100 py-6 last:pb-0"
        >
          {tx.type === "CURRENCY" && <FundSelect index={idx} />}
          {tx.type === "CURRENCY" && (
            <Field
              icon={<Landmark className="h-4 w-4 text-gray-400" />}
              label="Invested"
            >
              <TextInput
                value={tx.numAssets ? formatNumber(tx.numAssets, true) : ""}
                placeholder="250 000"
                onChange={(e) => handleChange("numAssets", idx, e)}
              />
            </Field>
          )}
          {tx.type === "CURRENCY" && (
            <Field
              icon={<Coins className="h-4 w-4 text-gray-400" />}
              label="Currency"
            >
              <FormSelect<CurrencyIsoCode>
                value={
                  tx.currency
                    ? { label: tx.currency, value: tx.currency as CurrencyIsoCode }
                    : undefined
                }
                setValue={(value) => {
                  const updatedTransactions = [...values.transfers];
                  updatedTransactions[idx] = {
                    ...updatedTransactions[idx],
                    currency: value?.value,
                  };

                  setFieldValue("transfers", updatedTransactions);
                }}
                options={currencyOptions}
              />
            </Field>
          )}
          {tx.type === "EQUITY" && (
            <Field
              icon={<Package className="h-4 w-4 text-gray-400" />}
              label="Number of shares"
            >
              <TextInput
                value={tx.numAssets ? formatNumber(tx.numAssets) : ""}
                placeholder="1,000"
                onChange={(e) => handleChange("numAssets", idx, e)}
              />
            </Field>
          )}
          {tx.type === "EQUITY" && (
            <Field label="Share Class" icon={null}>
              <TextInput
                value={tx.assetName ? tx.assetName : ""}
                placeholder="SAFE 2024"
                onChange={(e) => {
                  const updatedTransactions = [...values.transfers];
                  updatedTransactions[idx] = {
                    ...updatedTransactions[idx],
                    assetName: e.target.value,
                  };
                  setFieldValue("transfers", updatedTransactions);
                }}
              />
            </Field>
          )}
          {tx.converted && (
            <Field label="Conversion Price" icon={null}>
              <TextInput
                value={tx.conversionPrice ? formatNumber(tx.conversionPrice) : ""}
                placeholder="1.9"
                onChange={(e) => handleChange("conversionPrice", idx, e)}
              />
            </Field>
          )}
          {tx.converted && (
            <Field label="Interest" icon={null}>
              <TextInput
                value={tx.interestAmount ? formatNumber(tx.interestAmount) : ""}
                placeholder="20"
                onChange={(e) => handleChange("interestAmount", idx, e)}
              />
            </Field>
          )}
          {tx.converted && (
            <Field
              icon={<Coins className="h-4 w-4 text-gray-400" />}
              label="Currency"
            >
              <FormSelect<CurrencyIsoCode>
                value={
                  tx.currency
                    ? { label: tx.currency, value: tx.currency as CurrencyIsoCode }
                    : { label: "GBP", value: "GBP" as CurrencyIsoCode }
                }
                setValue={(value) => {
                  const updatedTransactions = [...values.transfers];
                  updatedTransactions[idx] = {
                    ...updatedTransactions[idx],
                    currency: value?.value,
                  };

                  setFieldValue("transfers", updatedTransactions);
                }}
                options={currencyOptions}
              />
            </Field>
          )}
          {tx.type === "CONVERTIBLE" && (
            <Field label="Convertible" icon={null}>
              <TextInput
                value={tx.assetName ? tx.assetName : ""}
                placeholder="SAFE 2024"
                onChange={(e) => {
                  const updatedTransactions = [...values.transfers];
                  updatedTransactions[idx] = {
                    ...updatedTransactions[idx],
                    assetName: e.target.value,
                  };
                  setFieldValue("transfers", updatedTransactions);
                }}
              />
            </Field>
          )}
          {tx.type === "CONVERTIBLE" && (
            <Field label="Type" icon={null} required>
              <FormSelect<ConvertibleType>
                value={
                  tx.convertibleType
                    ? {
                        label: convertUnderscore(tx.convertibleType),
                        value: tx.convertibleType as ConvertibleType,
                      }
                    : undefined
                }
                setValue={(value) => {
                  const updatedTransactions = [...values.transfers];
                  updatedTransactions[idx] = {
                    ...updatedTransactions[idx],
                    convertibleType: value?.value,
                  };

                  setFieldValue("transfers", updatedTransactions);
                }}
                options={convertibleOptions}
              />
            </Field>
          )}
          {tx.type === "CONVERTIBLE" && (
            <Field label="Maturity date" icon={null}>
              <TextInput
                type="date"
                value={
                  tx.maturityDate
                    ? format(new Date(tx.maturityDate), "yyyy-MM-dd")
                    : ""
                }
                onChange={(e) => {
                  const updatedTransactions = [...values.transfers];
                  updatedTransactions[idx] = {
                    ...updatedTransactions[idx],
                    maturityDate: e.target.value,
                  };
                  setFieldValue("transfers", updatedTransactions);
                }}
              />
            </Field>
          )}
          {tx.type === "CONVERTIBLE" && (
            <Field label="Interest %" icon={null}>
              <TextInput
                value={tx.interestRate ? tx.interestRate : ""}
                placeholder="5.2"
                onChange={(e) => handleChange("interestRate", idx, e)}
              />
            </Field>
          )}
          {tx.type === "CONVERTIBLE" && (
            <Field label="Discount %" icon={null}>
              <TextInput
                value={tx.discountRate ? formatNumber(tx.discountRate, true) : ""}
                placeholder="2.6"
                onChange={(e) => handleChange("discountRate", idx, e)}
              />
            </Field>
          )}
          {tx.type === "CONVERTIBLE" && (
            <Field label="Valuation Cap" icon={null}>
              <TextInput
                value={tx.valuationCap ? formatNumber(tx.valuationCap) : ""}
                placeholder="10 000 000"
                onChange={(e) => handleChange("valuationCap", idx, e)}
              />
            </Field>
          )}
          {tx.type === "CONVERTIBLE" && (
            <Field
              icon={<Coins className="h-4 w-4 text-gray-400" />}
              label="Currency"
            >
              <FormSelect<CurrencyIsoCode>
                value={
                  tx.valuationCapCurrency
                    ? {
                        label: tx.valuationCapCurrency,
                        value: tx.valuationCapCurrency as CurrencyIsoCode,
                      }
                    : { label: "GBP", value: "GBP" as CurrencyIsoCode }
                }
                setValue={(value) => {
                  const updatedTransactions = [...values.transfers];
                  updatedTransactions[idx] = {
                    ...updatedTransactions[idx],
                    currency: value?.value,
                  };

                  setFieldValue("transfers", updatedTransactions);
                }}
                options={currencyOptions}
              />
            </Field>
          )}
        </div>
      ))}
    </div>
  );
}

function FundSelect({ index }: { index: number }) {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const [funds, setFunds] = useState<{ label: string; value: string }[]>([]);
  const { mutateAsync: findInvestingEntitiesByName } =
    trpc.views.portfolio.company.findInvestingEntitiesByName.useMutation();
  useEffect(() => {
    const fetch = async () => {
      const entities = await findInvestingEntitiesByName({ name: "" });
      const options = entities.map((entity) => ({
        label: entity.name,
        value: entity.id,
      }));
      setFunds(options);
    };
    fetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedFund = useMemo(() => {
    return values["transfers"]
      ? funds.filter((fund) => fund.value === values["transfers"][index].fundId)[0]
      : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, funds]);

  return (
    <Field
      label="Fund"
      icon={<Building2 className="h-4 w-4 text-gray-400" />}
      required
    >
      <FormSelect
        placeholder="Fund..."
        value={selectedFund}
        options={funds}
        setValue={(value) => {
          const updatedTransactions = [...values.transfers];
          updatedTransactions[index] = {
            ...updatedTransactions[index],
            fundId: value?.value ?? "",
          };
          setFieldValue("transfers", updatedTransactions);
        }}
      />
    </Field>
  );
}

export { EditTransaction };
export type { FormValues, AssetTransfer, Transaction };
