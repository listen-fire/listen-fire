"use client";

/**
 * Acquisition: the acquirer buys the company, and each investing fund
 * swaps some of its holdings for cash and/or equity in the acquirer.
 * Ported from apps/app's AddDistribution/index.tsx AcquisitionFormBody.
 */

import { useMemo } from "react";
import { useFormikContext } from "formik";
import { ArrowLeft, ArrowRight, Plus, X } from "lucide-react";

import { CurrencyIsoCode } from "#trpc";

import {
  Field,
  FormSelect,
  FutureDateWarning,
  TextInput,
} from "@/components/portfolio";
import { buttonClass } from "@/components/ui";

import {
  AcquisitionsAssetSelect,
  FormActions,
  FundSelect,
  LegalEntitySelect,
} from "./shared";
import { currencyOptions, type AcquisitionFormValues } from "./types";

export function AcquisitionFormBody({ onClose }: { onClose: () => void }) {
  const {
    values,
    setFieldValue,
    setFieldTouched,
    submitForm,
    errors,
    touched,
  } = useFormikContext<AcquisitionFormValues>();

  const holdingsAfterSales = useMemo(() => {
    if (!values.company?.holdings) {
      return [];
    }

    return values.transactions
      .reduce(
        (acc, transaction) => {
          for (const asset of transaction.assetsSold) {
            const holding = acc.find(
              (h) => h.fundId === transaction.fundId && h.assetId === asset.id,
            );
            if (!holding) {
              continue;
            }

            const updatedHolding = {
              ...holding,
              numAssets: holding.numAssets - (asset.amount ?? 0),
            };
            acc.splice(acc.indexOf(holding), 1, updatedHolding);
          }

          return acc;
        },
        [...(values.company?.holdings ?? [])],
      )
      .filter((h) => h.numAssets > 0);
  }, [values.company?.holdings, values.transactions]);

  const hasError = (field: keyof AcquisitionFormValues) =>
    !!(touched[field] && errors[field]);

  return (
    <div className="mb-6 flex w-full flex-col items-stretch gap-6">
      <div className="flex w-full flex-col gap-4">
        <Field label="Exit date" icon={null} required>
          <TextInput
            type="date"
            invalid={hasError("date")}
            value={values.date}
            onChange={(e) => {
              setFieldValue("date", e.target.value);
              setFieldTouched("date", true);
            }}
          />
          <FutureDateWarning value={values.date ?? ""} />

          {hasError("date") && (
            <span className="text-[12px] text-red-500">{errors.date}</span>
          )}
        </Field>

        <LegalEntitySelect
          label="Acquirer"
          isRequired
          selectedEntity={values.buyer}
          onSelect={(entity) => {
            setFieldValue("buyer", entity);
            setFieldTouched("buyer", true);
          }}
          isDisabled={!!values.eventId}
          isInvalid={hasError("buyer")}
        />

        <Field label="Valuation of Acquirer" icon={null}>
          <div className="flex w-full items-center gap-2">
            <div className="w-32 shrink-0">
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
                placeholder="Currency..."
              />
            </div>
            <TextInput
              type="number"
              invalid={hasError("valuation")}
              value={values.valuation ?? ""}
              placeholder="e.g. 10000000"
              onChange={(e) => {
                const stripped = e.target.value.replace(/[^0-9.]/g, "");
                const val = stripped === "" ? undefined : parseFloat(stripped);
                setFieldValue("valuation", val);
                setFieldTouched("valuation", true);
              }}
            />
          </div>
        </Field>

        <Field label="Price Per Share for Acquirer" icon={null}>
          <div className="flex w-full items-center gap-2">
            <div className="w-32 shrink-0">
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
                placeholder="Currency..."
                isDisabled
              />
            </div>
            <TextInput
              type="number"
              invalid={hasError("pricePerShare")}
              value={values.pricePerShare ?? ""}
              placeholder="e.g. 100"
              onChange={(e) => {
                const val =
                  e.target.value === "" ? undefined : parseFloat(e.target.value);
                setFieldValue("pricePerShare", val);
                setFieldTouched("pricePerShare", true);
              }}
            />
          </div>
        </Field>
      </div>

      <div className="mt-4 flex w-full items-center justify-between">
        <span className="text-[15px] font-semibold text-gray-900">
          Transactions
        </span>
        <button
          type="button"
          className={buttonClass({ variant: "secondary", size: "sm" })}
          onClick={() => {
            // Add new transaction
            const items = [...(values.transactions || [])];
            items.push({
              fundId: "",
              assetsSold: [],
              assetsReceived: [],
            });
            setFieldValue("transactions", items);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Add Transaction
        </button>
      </div>

      {holdingsAfterSales.length > 0 && (
        <span className="text-[13px] text-gray-500">
          Currently receiving nothing for:{" "}
          {holdingsAfterSales
            .map((h) => `${h.numAssets} ${h.assetName} (${h.fundName})`)
            .join(", ")}
        </span>
      )}

      {values.transactions && values.transactions.length === 0 && (
        <span className="mx-auto text-[12px] text-gray-500">
          Add transactions
        </span>
      )}

      {values.transactions &&
        values.transactions.map((item, idx) => (
          <div
            key={idx}
            className="group relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-md bg-gray-50 p-4"
          >
            <button
              type="button"
              aria-label="Remove transaction"
              className={`${buttonClass({ variant: "ghost", size: "sm" })} absolute -right-1 -top-1 hidden h-10 w-10 justify-center rounded-full p-0 text-gray-900 group-hover:flex`}
              onClick={() => {
                const items = [...(values.transactions || [])];
                items.splice(idx, 1);
                setFieldValue("transactions", items);
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>

            <div className="flex max-w-full grow flex-col items-stretch gap-5">
              <FundSelect
                selected={item.fundId}
                onSelect={(value) => {
                  const items = [...(values.transactions || [])];
                  items[idx].fundId = value;
                  setFieldValue("transactions", items);
                }}
                holdings={values.company?.holdings}
              />

              <div className="flex flex-col items-stretch gap-3">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-900">
                    <ArrowLeft className="h-3.5 w-3.5" />
                    Received
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="Add received asset"
                      className={buttonClass({
                        variant: "secondary",
                        size: "sm",
                      })}
                      onClick={() => {
                        const items = [...(values.transactions || [])];
                        items[idx].assetsReceived.push({
                          assetId: "",
                          amount: undefined as unknown as number,
                          date: values.date,
                          type: "CASH",
                          shareClass: "",
                          currency: (values.currency ??
                            "USD") as CurrencyIsoCode,
                        });
                        setFieldValue("transactions", items);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Cash
                    </button>
                    <button
                      type="button"
                      aria-label="Add received asset"
                      className={buttonClass({
                        variant: "secondary",
                        size: "sm",
                      })}
                      onClick={() => {
                        const items = [...(values.transactions || [])];
                        items[idx].assetsReceived.push({
                          assetId: "",
                          amount: undefined as unknown as number,
                          date: values.date,
                          type: "EQUITY",
                          shareClass: "",
                          currency: (values.currency ?? "") as CurrencyIsoCode,
                        });
                        setFieldValue("transactions", items);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Equity
                    </button>
                  </div>
                </div>

                {item.assetsReceived.map((asset, assetIdx) => (
                  <div key={assetIdx} className="flex items-center gap-2">
                    <div className="flex flex-col items-stretch gap-2">
                      <span className="text-[13px] text-gray-900">
                        {asset.type === "CASH" ? "Cash" : "Equity"}
                      </span>
                      <div className="flex w-full flex-wrap items-center gap-2">
                        {asset.type === "CASH" && (
                          <div className="flex items-center gap-2">
                            <div className="w-[100px] shrink-0 grow">
                              <FormSelect<CurrencyIsoCode>
                                value={
                                  asset.currency
                                    ? {
                                        label: asset.currency,
                                        value: asset.currency,
                                      }
                                    : undefined
                                }
                                setValue={(value) => {
                                  const items = [
                                    ...(values.transactions || []),
                                  ];
                                  items[idx].assetsReceived[assetIdx].currency =
                                    value?.value as CurrencyIsoCode;
                                  setFieldValue("transactions", items);
                                }}
                                options={currencyOptions}
                                placeholder="Currency"
                              />
                            </div>
                            <TextInput
                              className="w-[100px] shrink"
                              type="number"
                              value={asset.amount}
                              onChange={(e) => {
                                const items = [...(values.transactions || [])];
                                const stripped = e.target.value.replace(
                                  /[^0-9.]/g,
                                  "",
                                );
                                items[idx].assetsReceived[assetIdx].amount =
                                  parseFloat(stripped);
                                setFieldValue("transactions", items);
                              }}
                            />
                          </div>
                        )}
                        {asset.type === "EQUITY" && (
                          <div className="flex items-center gap-2">
                            <TextInput
                              className="w-[100px] shrink"
                              type="number"
                              placeholder="e.g. 1000"
                              value={asset.amount}
                              onChange={(e) => {
                                const items = [...(values.transactions || [])];
                                const stripped = e.target.value.replace(
                                  /[^0-9.]/g,
                                  "",
                                );
                                items[idx].assetsReceived[assetIdx].amount =
                                  parseFloat(stripped);
                                setFieldValue("transactions", items);
                              }}
                            />
                            <TextInput
                              className="w-[100px] shrink"
                              type="text"
                              placeholder="Share class"
                              value={asset.shareClass}
                              onChange={(e) => {
                                const items = [...(values.transactions || [])];
                                items[idx].assetsReceived[assetIdx].shareClass =
                                  e.target.value;
                                setFieldValue("transactions", items);
                              }}
                            />
                          </div>
                        )}
                        <span className="text-[13px] text-gray-500">on</span>
                        <TextInput
                          className="w-auto shrink"
                          type="date"
                          value={asset.date}
                          onChange={(e) => {
                            const items = [...(values.transactions || [])];
                            items[idx].assetsReceived[assetIdx].date =
                              e.target.value;
                            setFieldValue("transactions", items);
                          }}
                        />
                        <FutureDateWarning value={asset.date} />
                        <button
                          type="button"
                          aria-label="Remove transaction"
                          className={`${buttonClass({ variant: "ghost", size: "sm" })} ml-auto h-7 w-7 justify-center rounded-full p-0 text-gray-900`}
                          onClick={() => {
                            const items = [...(values.transactions || [])];
                            items[idx].assetsReceived.splice(assetIdx, 1);
                            setFieldValue("transactions", items);
                          }}
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex flex-col items-stretch gap-3">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-2 text-[13px] font-medium text-gray-900">
                    <ArrowRight className="h-3.5 w-3.5" />
                    In exchange for
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="Add received asset"
                      className={buttonClass({
                        variant: "secondary",
                        size: "sm",
                      })}
                      onClick={() => {
                        const items = [...(values.transactions || [])];
                        items[idx].assetsSold.push({
                          id: "",
                          amount: undefined as unknown as number,
                        });
                        setFieldValue("transactions", items);
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Assets
                    </button>
                  </div>
                </div>
                {values.transactions[idx].assetsSold.map((_, assetIdx) => (
                  <AcquisitionsAssetSelect
                    key={assetIdx}
                    index={idx}
                    assetIndex={assetIdx}
                    holdings={values.company?.holdings}
                    isDisabled={false}
                  />
                ))}
              </div>
            </div>
          </div>
        ))}

      <FormActions
        onCancel={onClose}
        onSave={submitForm}
        saveLabel="Save Acquisition"
      />
    </div>
  );
}
