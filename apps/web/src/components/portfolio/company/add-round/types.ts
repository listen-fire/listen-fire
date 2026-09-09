import type { RouterInputs } from "@/lib/trpc";
import { CurrencyIsoCode, LegalEntityType } from "#trpc";

type FormValues = Partial<
  RouterInputs["views"]["portfolio"]["company"]["addRound"]
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

// AddRound only ever reads `id`; `type` is accepted so a caller can hand it
// the same entity object it hands AddInvestment.
export interface Entity {
  id: string;
  name: string;
  type?: LegalEntityType | null;
}
