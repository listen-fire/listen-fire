"use client";

/**
 * Currency/percent/plain numeric inputs built on react-number-format —
 * the financial forms use these for every dollar amount, ownership
 * percentage, and share count. Values are plain `number | undefined`;
 * react-number-format owns the display formatting.
 */

import { NumericFormat } from "react-number-format";
import type { CurrencyIsoCode } from "#trpc";
import { currencySymbol } from "./format";

const INPUT_CLASS =
  "w-full rounded-md border border-gray-200 px-3 py-2 text-[13px] focus:border-gray-400 focus:outline-none disabled:cursor-not-allowed disabled:bg-gray-50 disabled:text-gray-400";

export function MoneyInput({
  value,
  onChange,
  currency,
  placeholder,
  disabled,
  autoFocus,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  currency?: CurrencyIsoCode | keyof typeof CurrencyIsoCode;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const prefix = currency ? (currencySymbol(currency) ?? "") : "";
  return (
    <NumericFormat
      value={value ?? ""}
      onValueChange={(v) => onChange(v.floatValue)}
      thousandSeparator
      decimalScale={2}
      allowNegative={false}
      prefix={prefix}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      className={INPUT_CLASS}
    />
  );
}

export function PercentInput({
  value,
  onChange,
  placeholder,
  disabled,
  autoFocus,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <NumericFormat
      value={value ?? ""}
      onValueChange={(v) => onChange(v.floatValue)}
      thousandSeparator
      decimalScale={2}
      allowNegative={false}
      suffix="%"
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      className={INPUT_CLASS}
    />
  );
}

export function NumberInput({
  value,
  onChange,
  decimalScale = 0,
  placeholder,
  disabled,
  autoFocus,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  decimalScale?: number;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  return (
    <NumericFormat
      value={value ?? ""}
      onValueChange={(v) => onChange(v.floatValue)}
      thousandSeparator
      decimalScale={decimalScale}
      allowNegative={false}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      className={INPUT_CLASS}
    />
  );
}
