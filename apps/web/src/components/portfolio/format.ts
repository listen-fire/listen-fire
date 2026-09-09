/**
 * Formatting helpers ported near-verbatim from apps/app's
 * src/utils/{formatMoney,formatDate,formatTvpi,currency,convertUnderscore}.ts —
 * the financial forms that will land on top of these primitives depend on
 * this exact output (currency symbols, compact-number thresholds, TVPI "x"
 * suffix), so behavior is kept identical rather than rewritten.
 */

import { format as dateFnsFormat } from "date-fns";
import { CurrencyIsoCode } from "#trpc";

// ─── Currency ─────────────────────────────────────────────────────────

// Exhaustiveness check ported from currency.ts: fails to compile if a new
// CurrencyIsoCode variant is added without updating currencySymbol below.
const currencies = [
  CurrencyIsoCode.CHF,
  CurrencyIsoCode.NOK,
  CurrencyIsoCode.SEK,
  CurrencyIsoCode.DKK,
  CurrencyIsoCode.GBP,
  CurrencyIsoCode.EUR,
  CurrencyIsoCode.USD,
] as const;
type EnsureAllCurrencies<T extends readonly CurrencyIsoCode[]> =
  Exclude<CurrencyIsoCode, T[number]> extends never ? T : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const checkedCurrencies: EnsureAllCurrencies<typeof currencies> = currencies;

export function currencySymbol(
  currency: CurrencyIsoCode | keyof typeof CurrencyIsoCode,
): string | undefined {
  switch (currency.toUpperCase()) {
    case "CHF":
      return "CHF";
    case "NOK":
    case "SEK":
    case "DKK":
      return "kr";
    case "GBP":
      return "£";
    case "EUR":
      return "€";
    case "USD":
      return "$";
    default:
      return undefined;
  }
}

export { currencies };

// ─── Money ────────────────────────────────────────────────────────────

enum NumberAbbrSign {
  THOUSAND = "K",
  MILLION = "M",
  BILLION = "BN",
}

function formatAbbr(num: number, defaultFormat: string) {
  if (num < 10 ** 4) {
    return defaultFormat;
  }
  if (num < 10 ** 6) {
    return `${Math.round(num / 10 ** 2) / 10}${NumberAbbrSign.THOUSAND}`;
  }
  if (num < 10 ** 7) {
    return `${Math.round(num / 10 ** 4) / 100}${NumberAbbrSign.MILLION}`;
  }
  if (num < 10 ** 9) {
    return `${Math.round(num / 10 ** 5) / 10}${NumberAbbrSign.MILLION}`;
  }
  if (num < 10 ** 10) {
    return `${Math.round(num / 10 ** 7) / 100}${NumberAbbrSign.BILLION}`;
  }
  if (num < 10 ** 12) {
    return `${Math.round(num / 10 ** 8) / 10}${NumberAbbrSign.BILLION}`;
  }
  return defaultFormat;
}

export function formatMoney(
  sum?: number | null,
  config: {
    currency?: CurrencyIsoCode | keyof typeof CurrencyIsoCode | null;
    maximumFractionDigits?: number;
    isAbbrFormat?: boolean;
  } = {
    maximumFractionDigits: 2,
    isAbbrFormat: false,
  },
): string {
  if (sum === null || sum === undefined) {
    return "-";
  }

  const { currency, maximumFractionDigits, isAbbrFormat } = config;

  const formattedNumber = sum.toLocaleString(undefined, {
    maximumFractionDigits,
    minimumFractionDigits: maximumFractionDigits === 0 ? 0 : 2,
  });

  const resultNumber = isAbbrFormat
    ? formatAbbr(sum, formattedNumber)
    : formattedNumber;

  if (currency) {
    const symbol = currencySymbol(currency);
    return symbol
      ? `${symbol}${resultNumber}`
      : `${resultNumber} ${currency.toUpperCase()}`;
  }
  return resultNumber;
}

// ─── Date ─────────────────────────────────────────────────────────────

export function formatDate(date: Date, formatOption = "PPP"): string {
  return dateFnsFormat(date, formatOption);
}

// ─── TVPI ─────────────────────────────────────────────────────────────

export function formatTvpi(
  tvpi: number | null | undefined,
  decimals = 2,
): string {
  if (tvpi === null || tvpi === undefined || !Number.isFinite(tvpi)) {
    return "-";
  }
  return `${tvpi.toFixed(decimals)}x`;
}

// ─── Case conversion ──────────────────────────────────────────────────
//
// apps/app's convertUnderscore delegates to lodash's startCase/capitalize,
// but always after lowercasing and swapping underscores for spaces first —
// on that normalized input, startCase reduces to "capitalize every word"
// and capitalize reduces to "capitalize the first word". Reimplemented
// directly so this package doesn't need to pull in lodash for two words'
// worth of behavior.

function upperFirst(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

interface ConvertUnderscoreConfig {
  case?: "startCase" | "capitalize" | "lowerCase" | "upperCase";
}

export function convertUnderscore(
  value: string,
  config: ConvertUnderscoreConfig = { case: "startCase" },
): string {
  const resultValue = value.replace(/_/g, " ").toLowerCase();

  switch (config.case) {
    case "startCase":
      return resultValue
        .split(" ")
        .filter(Boolean)
        .map(upperFirst)
        .join(" ");
    case "capitalize":
      return upperFirst(resultValue);
    case "upperCase":
      return resultValue.toUpperCase();
    default:
      return resultValue;
  }
}

export function startCase(value: string): string {
  return convertUnderscore(value, { case: "startCase" });
}

// ─── Number input formatting ─────────────────────────────────────────

/**
 * apps/app's AddRound/Steps/utils.formatNumber — groups digits with spaces
 * and keeps at most one decimal point. Had four byte-identical (or
 * byte-identical-when-called-with-default-args) copies across the ported
 * step/edit/funding forms; consolidated here as the single canonical
 * definition. `toMaxFixed`, its sibling in the original utils.ts, stays
 * local to add-investment/steps since nothing else uses it.
 */
export function formatNumber(value: string | number, allowDecimals = true) {
  // Convert to string if number
  const stringValue = value.toString();

  // Remove any non-digit or decimal characters
  const numericValue = allowDecimals
    ? stringValue.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1") // Keep only first decimal point
    : stringValue.replace(/\D/g, "");

  // Split into integer and decimal parts if decimals allowed
  if (allowDecimals && numericValue.includes(".")) {
    const [integerPart, decimalPart] = numericValue.split(".");
    // Format integer part with spaces between groups
    const formattedInteger = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
    return `${formattedInteger}.${decimalPart}`;
  }

  // Format with spaces between groups
  return numericValue.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}
