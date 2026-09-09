/**
 * Ported verbatim from apps/app's Portfolio/Profile/AddDistribution/types.ts.
 * These shapes are what the exit/realisation mutations receive — the field
 * names line up with the tRPC inputs one-for-one, so do not rename them.
 */

import { CurrencyIsoCode } from "#trpc";

import type { Company } from "@/components/portfolio/company/types";

interface Distribution {
  eventId?: string;
  company: Company;
  buyer?: LegalEntity;
  valuation?: number;
  currency?: CurrencyIsoCode;
  date: string;
  pricePerShare?: number;
  transactions: Transaction[];
}

interface Transaction {
  fundId: string;
  assetsSold: {
    id: string;
    amount: number;
  }[];
  assetsReceived: {
    assetId: string;
    amount: number;
    date: string;
    type: "CASH" | "EQUITY";
    shareClass: string;
    currency: CurrencyIsoCode;
  }[];
}

interface AssetSell {
  sellerId: string;
  assetId: string;
  numAssets: number;
  pricePerShare: number;
  currency: CurrencyIsoCode;
}

type LegalEntity = {
  id: string;
  name: string;
  type: "NATURAL_PERSON" | "FUND";
};

interface SecondarySaleFormValues {
  companyId: string;
  date?: string;
  buyer?: LegalEntity;
  transactions: AssetSell[];
  currency?: CurrencyIsoCode;
}

interface DividendsFormValues {
  company: Company;
  date?: string;
  amount?: number;
  currency?: CurrencyIsoCode;
  fundId?: string;
}

interface LiquidationFormValues {
  company: Company;
  date?: string;
  transactions: {
    investorId: string;
    numAssets: number;
    currency: CurrencyIsoCode;
  }[];
}

interface FundDistributionFormValues {
  company: Company;
  date?: string;
  amount?: number;
  currency?: CurrencyIsoCode;
  fundId?: string;
}

type AcquisitionFormValues = Distribution;

export type TransactionType =
  | "ACQUISITION"
  | "SECONDARY_SALE"
  | "DIVIDENDS"
  | "LIQUIDATION"
  | "FUND_DISTRIBUTION";

const currencies = [
  CurrencyIsoCode.USD,
  CurrencyIsoCode.EUR,
  CurrencyIsoCode.GBP,
  CurrencyIsoCode.CHF,
  CurrencyIsoCode.NOK,
  CurrencyIsoCode.SEK,
  CurrencyIsoCode.DKK,
] satisfies CurrencyIsoCode[];

const currencyOptions = currencies.map((currency) => ({
  label: currency,
  value: currency,
}));

/** Holdings as `getOverview` returns them — every fund/asset select reads these. */
type Holdings = NonNullable<Company>["holdings"];

/** Props every one of the five exit forms takes. `onOpen` is accepted but
 * unused so a `{...disclosure}` spread from the funding section compiles. */
interface AddDistributionProps {
  company: Company;
  isOpen: boolean;
  onClose: () => void;
  onOpen?: () => void;
}

export { currencyOptions };

export type {
  AcquisitionFormValues,
  AddDistributionProps,
  AssetSell,
  DividendsFormValues,
  FundDistributionFormValues,
  Holdings,
  LegalEntity,
  LiquidationFormValues,
  SecondarySaleFormValues,
};
