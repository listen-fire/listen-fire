"use client";

import { FormSelect } from "@/components/portfolio";
import { CurrencyIsoCode } from "#trpc";

const CURRENCIES = [
  CurrencyIsoCode.USD,
  CurrencyIsoCode.EUR,
  CurrencyIsoCode.GBP,
  CurrencyIsoCode.CHF,
  CurrencyIsoCode.NOK,
  CurrencyIsoCode.SEK,
  CurrencyIsoCode.DKK,
] satisfies CurrencyIsoCode[];

const CURRENCY_OPTIONS = CURRENCIES.map((currency) => ({ label: currency, value: currency }));

export function CurrencySelect({
  value,
  onChange,
}: {
  value: CurrencyIsoCode | null;
  onChange: (value: CurrencyIsoCode | null) => void;
}) {
  const selected = CURRENCY_OPTIONS.find((option) => option.value === value);

  return (
    <FormSelect<CurrencyIsoCode>
      value={selected}
      setValue={(option) => onChange(option?.value ?? null)}
      options={CURRENCY_OPTIONS}
      placeholder="Select currency"
    />
  );
}
