"use client";

import { useEffect } from "react";
import { useFormikContext } from "formik";
import { Banknote, Bookmark, Calendar, Percent, Tag } from "lucide-react";

import { Field, FormSelect, TextInput, formatNumber } from "@/components/portfolio";

import { currencyOptions, type FormValues } from "../types";
import { useStepper } from "../stepper";

import { ConvertibleType, CurrencyIsoCode } from "#trpc";

const ICON = "h-4 w-4 text-gray-400";

const convertibleTypeMap: Record<ConvertibleType, string> = {
  ASA: "ASA",
  BSA_AIR: "BSA/AIR",
  CONVERTIBLE_NOTE: "Convertible Note",
  LOAN: "Loan",
  POST_MONEY_SAFE: "Post-Money SAFE",
  PRE_MONEY_SAFE: "Pre-Money SAFE",
  SAFT: "SAFT",
  SEEDFAST: "SEEDFAST",
  SEEDNOTE: "SEEDNOTE",
  SLIP: "SLIP",
};

const convertibleTypes = Object.entries(convertibleTypeMap).map(
  ([key, value]) => ({
    label: value,
    value: key as ConvertibleType,
  }),
);

export function ConvertibleDetails() {
  const { values, setFieldValue, setFieldTouched } =
    useFormikContext<FormValues>();
  const { setStepValidity } = useStepper();

  useEffect(() => {
    if (values.convertibleType && values.convertibleName) {
      setStepValidity("HEAVY_DETAIL", true);
    } else {
      setStepValidity("HEAVY_DETAIL", false);
    }
  }, [values, setStepValidity]);

  return (
    <div className="flex w-full flex-col items-stretch gap-6">
      <Field icon={<Tag className={ICON} />} label="Type" required>
        <FormSelect<ConvertibleType>
          autoFocus
          placeholder="e.g. SAFE, Note"
          value={
            values.convertibleType
              ? {
                  label: convertibleTypeMap[values.convertibleType],
                  value: values.convertibleType,
                }
              : undefined
          }
          setValue={(value) => setFieldValue("convertibleType", value?.value)}
          options={convertibleTypes}
        />
      </Field>

      <Field icon={<Bookmark className={ICON} />} label="Name" required>
        <TextInput
          onFocus={() => setFieldTouched("convertibleName")}
          value={values.convertibleName || ""}
          onChange={(e) => setFieldValue("convertibleName", e.target.value)}
          placeholder="e.g. SAFE 2023"
        />
      </Field>
      <Field icon={<Banknote className={ICON} />} label="Valuation Cap">
        <div className="flex w-full items-start gap-2">
          <div className="w-[110px] shrink-0">
            <FormSelect<CurrencyIsoCode>
              value={
                values.investmentCurrency
                  ? {
                      label: values.investmentCurrency,
                      value: values.investmentCurrency,
                    }
                  : undefined
              }
              setValue={(value) =>
                setFieldValue("convertibleValuationCapCurrency", value?.value)
              }
              options={currencyOptions}
              isDisabled
            />
          </div>
          <TextInput
            className="grow"
            value={
              values.convertibleValuationCap
                ? formatNumber(values.convertibleValuationCap, false)
                : ""
            }
            onChange={(e) => {
              const numericValue = e.target.value.replace(/[^\d]/g, "");
              setFieldValue(
                "convertibleValuationCap",
                numericValue ? Number(numericValue) : undefined,
              );
            }}
            placeholder="e.g. 10000000"
          />
        </div>
      </Field>
      <Field icon={<Calendar className={ICON} />} label="Maturity Date">
        <TextInput
          type="date"
          value={values.convertibleMaturityDate || ""}
          onChange={(e) =>
            setFieldValue("convertibleMaturityDate", e.target.value)
          }
        />
      </Field>

      <div className="grid grid-cols-2 gap-6">
        <Field icon={<Percent className={ICON} />} label="Interest Rate">
          <TextInput
            value={
              values.convertibleInterestRate
                ? formatNumber(values.convertibleInterestRate, true)
                : ""
            }
            onChange={(e) => {
              const numericValue = e.target.value.replace(/[^\d.]/g, "");
              setFieldValue(
                "convertibleInterestRate",
                numericValue ? Number(numericValue) : undefined,
              );
            }}
            placeholder="e.g. 5"
          />
        </Field>

        <Field icon={<Percent className={ICON} />} label="Discount Rate">
          <TextInput
            value={
              values.convertibleDiscountRate
                ? formatNumber(values.convertibleDiscountRate, true)
                : ""
            }
            onChange={(e) => {
              const numericValue = e.target.value.replace(/[^\d.]/g, "");
              setFieldValue(
                "convertibleDiscountRate",
                numericValue ? Number(numericValue) : undefined,
              );
            }}
            placeholder="e.g. 20"
          />
        </Field>
      </div>
    </div>
  );
}
