"use client";

/**
 * Dividends: a cash payment from the company to one investing fund.
 * Ported from apps/app's AddDistribution/index.tsx DividendsFormBody.
 */

import { useFormikContext } from "formik";

import { CurrencyIsoCode } from "#trpc";

import { Field, FormSelect, FutureDateWarning, TextInput } from "@/components/portfolio";

import { FormActions, FundSelect } from "./shared";
import { currencyOptions, type DividendsFormValues } from "./types";

export function DividendsFormBody({ onClose }: { onClose: () => void }) {
  const { values, setFieldValue, setFieldTouched, submitForm } =
    useFormikContext<DividendsFormValues>();

  return (
    <div className="flex flex-col items-stretch gap-6 overflow-x-hidden">
      <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-3">
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
          label="Select Fund"
          selected={values.fundId}
          holdings={values.company?.holdings}
          onSelect={(fundId) => {
            setFieldValue(`fundId`, fundId);
            setFieldTouched(`fundId`, true);
          }}
          isRequired
        />

        <Field label="Amount" icon={null} required>
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
        </Field>

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

      <FormActions onCancel={onClose} onSave={submitForm} saveLabel="Save" />
    </div>
  );
}
