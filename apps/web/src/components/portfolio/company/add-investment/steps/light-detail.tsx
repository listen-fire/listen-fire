"use client";

import { useEffect } from "react";
import { useFormikContext } from "formik";
import { Bookmark, Landmark } from "lucide-react";

import { Field, FormSelect, TextInput, formatNumber } from "@/components/portfolio";

import { currencyOptions, type FormValues } from "../types";
import { useStepper } from "../stepper";

import { CurrencyIsoCode } from "#trpc";

const ICON = "h-4 w-4 text-gray-400";

export function LightDetail() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const { setStepValidity } = useStepper();
  const entityIsFund = values["entityType"] === "FUND";

  useEffect(() => {
    if (
      values["investmentCurrency"] &&
      values["investmentAmount"] &&
      (entityIsFund || values["investmentType"])
    ) {
      setStepValidity("LIGHT_DETAIL", true);
    } else {
      setStepValidity("LIGHT_DETAIL", false);
    }
  }, [values, setStepValidity, entityIsFund]);

  useEffect(() => {
    if (!entityIsFund && !values["investmentType"]) {
      setFieldValue("investmentType", "EQUITY");
    }
  }, [values, setFieldValue, entityIsFund]);

  return (
    <div className="flex w-full flex-col items-stretch gap-8 overflow-x-hidden">
      <InvestmentAmount />
      {entityIsFund ? null : <InvestmentType />}
    </div>
  );
}

function InvestmentAmount() {
  const { values, setFieldValue } = useFormikContext<FormValues>();

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Store raw numeric value in form state
    const numericValue = e.target.value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    setFieldValue("investmentAmount", numericValue);
  };

  return (
    <Field icon={<Landmark className={ICON} />} label="Invested Amount" required>
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
              setFieldValue("investmentCurrency", value?.value)
            }
            options={currencyOptions}
          />
        </div>
        <TextInput
          className="grow"
          autoFocus
          value={
            values.investmentAmount ? formatNumber(values.investmentAmount) : ""
          }
          onChange={handleChange}
          placeholder="Amount invested"
          type="text"
          inputMode="decimal"
          pattern="[0-9\s.]*"
        />
      </div>
    </Field>
  );
}

const investmentTypeOptions = ["EQUITY", "CONVERTIBLE", "SPV", "SECONDARY"] as const;

const investmentTypeLabels: Record<
  (typeof investmentTypeOptions)[number],
  string
> = {
  EQUITY: "Equity",
  CONVERTIBLE: "Convertible",
  SPV: "SPV",
  SECONDARY: "Secondary",
};

function InvestmentType() {
  const { values, setFieldValue } = useFormikContext<FormValues>();

  return (
    <Field icon={<Bookmark className={ICON} />} label="Investment Type" required>
      <div
        role="radiogroup"
        aria-label="Investment Type"
        className="grid grid-cols-2 gap-3"
      >
        {investmentTypeOptions.map((option) => {
          const isChecked = values.investmentType === option;
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={isChecked}
              onClick={() => setFieldValue("investmentType", option)}
              className={`rounded-md border px-4 py-2 text-[13px] transition-colors hover:border-primary-600 hover:bg-primary-50 hover:text-primary-600 ${
                isChecked
                  ? "border-primary-200 bg-primary-50 text-primary-600"
                  : "border-primary-200 text-gray-700"
              }`}
            >
              {investmentTypeLabels[option]}
            </button>
          );
        })}
      </div>
    </Field>
  );
}
