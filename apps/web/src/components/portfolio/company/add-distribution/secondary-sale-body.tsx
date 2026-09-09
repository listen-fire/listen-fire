"use client";

/**
 * Secondary sale: one buyer takes shares off one or more selling funds at
 * an agreed price per share. Ported from apps/app's AddDistribution/
 * index.tsx SecondarySaleFormBody — the available-shares clamp and the
 * total-amount → price-per-share derivation are unchanged.
 */

import { useFormikContext } from "formik";
import { Minus } from "lucide-react";

import { CurrencyIsoCode } from "#trpc";

import {
  Field,
  FormSelect,
  FutureDateWarning,
  TextInput,
  useToast,
} from "@/components/portfolio";
import { buttonClass } from "@/components/ui";
import type { Company } from "@/components/portfolio/company/types";

import {
  AssetSelect,
  FormActions,
  FundSelect,
  LegalEntitySelect,
} from "./shared";
import {
  currencyOptions,
  type AssetSell,
  type SecondarySaleFormValues,
} from "./types";

export function SecondarySaleFormBody({ company }: { company: Company }) {
  const toast = useToast();
  const {
    values,
    setFieldValue,
    setFieldTouched,
    submitForm,
    errors,
    touched,
  } = useFormikContext<SecondarySaleFormValues>();

  const hasError = (field: keyof SecondarySaleFormValues) =>
    !!(touched[field] && errors[field]);
  const hasTransactionError = (
    index: number,
    field: keyof AssetSell,
  ): boolean => {
    const isTouched = touched.transactions?.[index]?.[field];
    if (!isTouched) {
      return false;
    }

    const transactionErrors = errors.transactions;

    if (Array.isArray(transactionErrors) && transactionErrors[index]) {
      const itemErrors = transactionErrors[index];

      if (
        typeof itemErrors === "object" &&
        itemErrors !== null &&
        itemErrors[field]
      ) {
        return true;
      }
    }

    return false;
  };

  return (
    <div className="flex flex-col items-stretch gap-6 overflow-x-hidden">
      <div className="flex w-full flex-col gap-5">
        <Field label="Sale Date" icon={null} required>
          <TextInput
            type="date"
            invalid={hasError("date")}
            value={values.date ?? ""}
            onChange={(e) => {
              setFieldValue("date", e.target.value);
              setFieldTouched("date", true);
            }}
          />
          <FutureDateWarning value={values.date ?? ""} />
        </Field>

        <LegalEntitySelect
          label="Buyer"
          isRequired
          selectedEntity={values.buyer}
          onSelect={(entity) => {
            setFieldValue("buyer", entity);
            setFieldTouched("buyer", true);
          }}
          isInvalid={hasError("buyer")}
        />

        <Field label="Currency" icon={null} required>
          <FormSelect<CurrencyIsoCode>
            value={
              values.currency
                ? { label: values.currency, value: values.currency }
                : undefined
            }
            setValue={(value) => {
              setFieldValue("currency", value?.value);
              setFieldTouched("currency", true);
            }}
            options={currencyOptions}
            placeholder="Select..."
          />
        </Field>
      </div>

      <div className="mt-4 flex w-full items-center justify-between gap-4">
        <span className="text-[15px] font-semibold text-gray-900">
          Assets Sold
        </span>
        <button
          type="button"
          className={buttonClass({ variant: "secondary", size: "sm" })}
          onClick={() => {
            const current = [...(values.transactions || [])];
            current.push({
              sellerId: "",
              assetId: "",
              numAssets: 0,
              pricePerShare: 0,
              currency: CurrencyIsoCode.GBP,
            });
            setFieldValue("transactions", current);
          }}
        >
          Add Asset Sale
        </button>
      </div>

      {values.transactions.length === 0 && (
        <span className="text-[12px] text-gray-500">
          Add each asset sold by a fund in this transaction.
        </span>
      )}

      {values.transactions.map((item, idx) => {
        const currentHolding = company?.holdings
          ?.filter((h) => h.fundId === item.sellerId)
          .find((h) => h.assetId === item.assetId);
        const availableShares = currentHolding?.numAssets ?? 0;

        return (
          <div
            key={idx}
            className="grid grid-cols-1 items-end gap-4 rounded-md bg-gray-50 p-4 md:grid-cols-9"
          >
            <div className="col-span-1 md:col-span-5">
              <FundSelect
                fieldPrefix={`transactions[${idx}]`}
                label="Selling Fund"
                selected={item.sellerId}
                holdings={company?.holdings}
                onSelect={(fundId) => {
                  setFieldValue(`transactions[${idx}].assetId`, undefined);
                  setFieldValue(`transactions[${idx}].numAssets`, undefined);
                  setFieldValue(`transactions[${idx}].sellerId`, fundId);
                  setFieldTouched(`transactions[${idx}].sellerId`, true);
                }}
                isRequired
                isInvalid={hasTransactionError(idx, "sellerId")}
              />
            </div>

            <div className="col-span-1 md:col-span-4">
              <AssetSelect
                index={idx}
                holdings={company?.holdings}
                fieldPrefix={`transactions[${idx}]`}
                isDisabled={!item.sellerId}
                isRequired
                isInvalid={hasTransactionError(idx, "assetId")}
              />
            </div>

            <div className="col-span-1 md:col-span-5">
              <Field label="Selling (# Shares)" icon={null} required>
                <TextInput
                  disabled={!item.assetId}
                  type="number"
                  invalid={hasTransactionError(idx, "numAssets")}
                  value={item.numAssets ?? ""}
                  placeholder={`Max: ${availableShares}`}
                  max={availableShares}
                  onChange={(e) => {
                    const stripped = e.target.value.replace(/[^0-9.]/g, "");
                    const sellingAmount = parseFloat(stripped) || 0;

                    if (sellingAmount > availableShares) {
                      toast.error(
                        `Cannot sell more than the available ${availableShares} shares.`,
                      );
                    } else {
                      setFieldValue(
                        `transactions[${idx}].numAssets`,
                        sellingAmount < 0 ? 0 : sellingAmount,
                      );
                    }
                    setFieldTouched(`transactions[${idx}].numAssets`, true);
                  }}
                />
              </Field>
            </div>

            <div className="col-span-1 md:col-span-4">
              <Field label="Price per Share" icon={null} required>
                <TextInput
                  disabled={!item.numAssets}
                  type="number"
                  invalid={hasTransactionError(idx, "pricePerShare")}
                  value={item.pricePerShare ?? ""}
                  placeholder="e.g., 3.5"
                  onChange={(e) => {
                    const stripped = e.target.value.replace(/[^0-9.]/g, "");
                    setFieldValue(
                      `transactions[${idx}].pricePerShare`,
                      parseFloat(stripped) || 0,
                    );
                    setFieldTouched(`transactions[${idx}].pricePerShare`, true);
                  }}
                />
              </Field>
            </div>

            <div className="col-span-1 md:col-span-4">
              <Field label="Total Amount" icon={null}>
                <TextInput
                  disabled={!item.numAssets}
                  type="number"
                  step="any"
                  invalid={hasTransactionError(idx, "pricePerShare")}
                  placeholder="e.g., 40000" // Removed space for better number parsing potentially
                  onChange={(e) => {
                    const rawValue = e.target.value.replace(/[^0-9.]/g, "");
                    let newValue;

                    if (rawValue === "") {
                      newValue = null;
                    } else {
                      const parsedValue = parseFloat(rawValue);
                      newValue = isNaN(parsedValue) ? null : parsedValue;
                    }

                    const pricePerShare =
                      item.numAssets > 0 && newValue
                        ? newValue / item.numAssets
                        : 0;

                    setFieldValue(
                      `transactions[${idx}].pricePerShare`,
                      pricePerShare,
                    );
                    setFieldTouched(`transactions[${idx}].pricePerShare`, true);
                  }}
                />
              </Field>
            </div>

            <div className="col-span-1 md:col-span-4">
              <Field label="Currency" icon={null} required>
                <FormSelect<CurrencyIsoCode>
                  value={
                    item.currency
                      ? { label: item.currency, value: item.currency }
                      : undefined
                  }
                  setValue={(value) => {
                    setFieldValue(
                      `transactions[${idx}].currency`,
                      value?.value,
                    );
                    setFieldTouched(`transactions[${idx}].currency`, true);
                  }}
                  options={currencyOptions}
                  placeholder="Select..."
                />
              </Field>
            </div>

            <div className="col-span-1 text-right md:col-span-1 md:text-center">
              <button
                type="button"
                title="Remove asset sale"
                aria-label="Remove asset sale"
                className={`${buttonClass({ variant: "ghost", size: "sm" })} h-10 w-10 justify-center rounded-full p-0 text-red-500 hover:bg-red-50 hover:text-red-600`}
                onClick={() => {
                  const items = [...(values.transactions || [])];
                  items.splice(idx, 1);
                  setFieldValue("transactions", items);
                }}
              >
                <Minus className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        );
      })}

      <FormActions onSave={() => submitForm()} saveLabel="Save Secondary Sale" />
    </div>
  );
}
