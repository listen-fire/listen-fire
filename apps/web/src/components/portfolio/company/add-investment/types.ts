import type { RouterInputs } from "@/lib/trpc";
import { CurrencyIsoCode, LegalEntityType } from "#trpc";

type FormValues = Partial<
  RouterInputs["views"]["portfolio"]["company"]["addInvestment"]
>;

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
  label: currency as string,
  value: currency,
}));

export type { FormValues };
export { currencyOptions };

export interface Entity {
  id: string;
  name: string;
  type: LegalEntityType | null;
}
