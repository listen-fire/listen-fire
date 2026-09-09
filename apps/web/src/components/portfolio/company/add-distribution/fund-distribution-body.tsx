"use client";

/**
 * Fund distribution: the investing fund pays proceeds out to its own
 * investors. Ported from apps/app's AddDistribution/index.tsx
 * FundDistributionFormBody.
 */

import { useFormikContext } from "formik";

import { CurrencyIsoCode } from "#trpc";

import { Field, FormSelect, FutureDateWarning, TextInput } from "@/components/portfolio";

import { FormActions, FundSelect } from "./shared";
import { currencyOptions, type FundDistributionFormValues } from "./types";

export function FundDistributionFormBody({
  onClose,
}: {
  onClose: () => void;
}) {
  const { values, setFieldValue, setFieldTouched, submitForm } =
    useFormikContext<FundDistributionFormValues>();

  return (
    <div className="flex flex-col items-stretch gap-6 overflow-x-hidden">
      <div className="grid w-full grid-cols-1 gap-4">
        <Field label="Date" icon={null} required>
          <TextInput
            type="date"
            value={values.date ?? ""}
            onChange={(e) => {
              setFieldValue("date", e.target.value);
              setFieldTouched("date", true);
            }}
          />
          <FutureDateWarning value={values.date ?? ""} />
        </Field>

        <FundSelect
          label="Select Investing Fund"
          selected={values.fundId}
          holdings={values.company?.holdings}
          onSelect={(fundId) => {
            setFieldValue(`fundId`, fundId);
            setFieldTouched(`fundId`, true);
          }}
          isRequired
        />

        <Field label="Distribution Amount" icon={null} required>
          <div className="flex items-center gap-2">
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
                placeholder="Select..."
              />
            </div>
            <TextInput
              type="number"
              value={values.amount ?? ""}
              placeholder={"e.g., 1000"}
              onChange={(e) => {
                const rawValue = e.target.value.replace(/[^0-9.]/g, "");
                let newValue;

                if (rawValue === "") {
                  newValue = null;
                } else {
                  const parsedValue = parseFloat(rawValue);
                  newValue = isNaN(parsedValue) ? null : parsedValue;
                }

                const amount = newValue ? newValue : "";
                setFieldValue(`amount`, amount);
                setFieldTouched(`amount`, true);
              }}
            />
          </div>
        </Field>
      </div>

      <FormActions onCancel={onClose} onSave={submitForm} saveLabel="Save" />
    </div>
  );
}
