"use client";

/**
 * Wind down: the company is dissolved and each fund books whatever
 * proceeds it received. Ported from apps/app's AddDistribution/index.tsx
 * LiquidationFormBody + LiquidationTransaction.
 */

import { useState } from "react";
import { useFormikContext } from "formik";
import { Minus, Plus } from "lucide-react";

import { CurrencyIsoCode } from "#trpc";

import { Field, FormSelect, FutureDateWarning, TextInput } from "@/components/portfolio";
import type { Company } from "@/components/portfolio/company/types";
import { buttonClass } from "@/components/ui";

import { FormActions, FundSelect } from "./shared";
import { currencyOptions, type LiquidationFormValues } from "./types";

export function LiquidationFormBody({
  company,
  onClose,
}: {
  company: Company;
  onClose: () => void;
}) {
  const { values, setFieldValue, submitForm, setFieldTouched } =
    useFormikContext<LiquidationFormValues>();

  return (
    <div className="flex w-full flex-col items-stretch gap-6 overflow-x-hidden">
      <Field label="Exit date" icon={null} required>
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

      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium text-gray-900">Proceeds</span>
        <button
          type="button"
          aria-label="Add distribution"
          className={`${buttonClass({ variant: "secondary", size: "sm" })} rounded-full`}
          onClick={() => {
            const items = [...(values.transactions || [])];
            items.push({
              investorId: "",
              numAssets: 0,
              currency: CurrencyIsoCode.USD,
            });
            setFieldValue("transactions", items);
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>

      {values.transactions.map((transaction, idx) => (
        <LiquidationTransaction
          key={idx}
          transaction={transaction}
          company={company}
          idx={idx}
        />
      ))}

      {values.transactions.length === 0 && (
        <span className="text-center text-[13px] text-gray-500">
          Add your proceeds from the wind down
        </span>
      )}

      <FormActions onCancel={onClose} onSave={submitForm} saveLabel="Save" />
    </div>
  );
}

function LiquidationTransaction({
  transaction,
  company,
  idx,
}: {
  transaction: LiquidationFormValues["transactions"][number];
  company: Company;
  idx: number;
}) {
  const { values, setFieldValue } = useFormikContext<LiquidationFormValues>();
  const [receivedAmountString, setReceivedAmountString] = useState(
    transaction.numAssets.toString(),
  );

  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr]">
      <FundSelect
        selected={transaction.investorId}
        holdings={company?.holdings}
        onSelect={(fundId) => {
          const items = [...(values.transactions || [])];
          items[idx].investorId = fundId;
          setFieldValue("transactions", items);
        }}
      />
      <Field label="Received amount" icon={null}>
        <div className="flex items-center gap-2">
          <div className="w-32 shrink-0">
            <FormSelect<CurrencyIsoCode>
              value={
                transaction.currency
                  ? {
                      label: transaction.currency,
                      value: transaction.currency,
                    }
                  : undefined
              }
              setValue={(value) => {
                const items = [...(values.transactions || [])];
                items[idx].currency = value?.value ?? CurrencyIsoCode.USD;
                setFieldValue("transactions", items);
              }}
              options={currencyOptions}
              placeholder="Select..."
            />
          </div>
          <TextInput
            value={receivedAmountString}
            onChange={(e) => {
              const stripped = e.target.value.replace(/[^0-9.]/g, "");
              setReceivedAmountString(stripped);
              if (isNaN(parseFloat(stripped))) {
                return;
              }

              const items = [...(values.transactions || [])];
              items[idx].numAssets = parseFloat(stripped);
              setFieldValue("transactions", items);
            }}
            pattern="^\d+\.?\d{0,2}$"
          />
          <button
            type="button"
            aria-label="Remove distribution"
            className={`${buttonClass({ variant: "ghost", size: "sm" })} h-10 w-10 shrink-0 justify-center rounded-full p-0 text-red-500 hover:bg-red-50 hover:text-red-600`}
            onClick={() => {
              const items = [...(values.transactions || [])];
              items.splice(idx, 1);
              setFieldValue("transactions", items);
            }}
          >
            <Minus className="h-3.5 w-3.5" />
          </button>
        </div>
      </Field>
    </div>
  );
}
