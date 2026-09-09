"use client";

import { useEffect } from "react";
import { useFormikContext } from "formik";
import { Landmark } from "lucide-react";

import { Field, FormSelect, TextInput, formatNumber } from "@/components/portfolio";

import { currencyOptions, type FormValues } from "../types";
import { useStepper } from "../stepper";

import { CurrencyIsoCode } from "#trpc";

const ICON = "h-4 w-4 text-gray-400";

export function FundDetails() {
  const { values } = useFormikContext<FormValues>();
  const { setStepValidity } = useStepper();

  useEffect(() => {
    if (values["committedAmount"] && values["investmentAmount"]) {
      setStepValidity("FUND_DETAIL", true);
    } else {
      setStepValidity("FUND_DETAIL", false);
    }
  }, [values, setStepValidity]);

  return (
    <div className="flex w-full flex-col items-stretch gap-8 overflow-x-hidden">
      <InvestmentAmount />
      <CommitmentAmount />
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
    <Field
      icon={<Landmark className={ICON} />}
      label="Amount Drawn Down"
      required
    >
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

function CommitmentAmount() {
  const { values, setFieldValue } = useFormikContext<FormValues>();

  // Set default currencies to match investment currency
  useEffect(() => {
    if (values.investmentCurrency) {
      setFieldValue("committedCurrency", values.investmentCurrency);
    }
  }, [values.investmentCurrency, setFieldValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    // Store raw numeric value in form state
    const numericValue = e.target.value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    setFieldValue("committedAmount", numericValue);
  };

  return (
    <Field
      icon={<Landmark className={ICON} />}
      label="Committed Amount"
      required
    >
      <div className="flex w-full items-start gap-2">
        <div className="w-[110px] shrink-0">
          <FormSelect<CurrencyIsoCode>
            value={
              values.committedCurrency
                ? {
                    label: values.committedCurrency,
                    value: values.committedCurrency,
                  }
                : undefined
            }
            setValue={(value) =>
              setFieldValue("committedCurrency", value?.value)
            }
            options={currencyOptions}
            isDisabled
          />
        </div>
        <TextInput
          className="grow"
          value={
            values.committedAmount ? formatNumber(values.committedAmount) : ""
          }
          onChange={handleChange}
          placeholder="Amount committed"
          type="text"
          inputMode="decimal"
          pattern="[0-9\s.]*"
        />
      </div>
    </Field>
  );
}
