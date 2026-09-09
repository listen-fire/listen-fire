import type { RouterOutputs } from "@/lib/trpc";
import { CurrencyIsoCode } from "#trpc";

/**
 * Shared shapes for the holdings list + changelog (Phase 5.1, V-20). The
 * item shape is read straight off the router output rather than redeclared,
 * so a column that reads a field the query stopped returning is a type
 * error here, not a runtime `undefined`.
 */

export type Investment =
  RouterOutputs["views"]["investments"]["getPortfolioInvestments"]["items"][number];

export type ProcessMessage = Exclude<Investment["message"], undefined>[number];

export type ChangelogEntry =
  RouterOutputs["views"]["portfolio"]["company"]["getChangelogList"]["items"][number];

export type EntityTypeFilter =
  | "COMPANY"
  | "ESOP"
  | "FUND"
  | "NATURAL_PERSON"
  | "PORTFOLIO_COMPANY"
  | "SPV";

export type Grouping = "investment_date" | "moic" | "fair_value" | "total_value";

export type Aggregation = "company" | "investment";

export interface PortfolioFilter {
  fromDate: string | null;
  toDate: string | null;
  raisedFrom: string | null;
  raisedTo: string | null;
  portfolioIds: string[];
  coInvestors: string[];
  name: string | null;
  grouping: Grouping;
  themes: string[];
  geos: string[];
  entityTypes: EntityTypeFilter[];
}

export interface PortfolioConfig {
  portfolioIds: string[];
  currency: CurrencyIsoCode | null;
  valuationDate: string | null;
  aggregation: Aggregation;
  showDetails: boolean;
  showTotals: boolean;
}

export const DEFAULT_FILTER: PortfolioFilter = {
  fromDate: null,
  toDate: null,
  raisedFrom: null,
  raisedTo: null,
  portfolioIds: [],
  coInvestors: [],
  name: null,
  grouping: "investment_date",
  themes: [],
  geos: [],
  entityTypes: [],
};

export const DEFAULT_CONFIG: PortfolioConfig = {
  portfolioIds: [],
  currency: CurrencyIsoCode.USD,
  valuationDate: null,
  aggregation: "company",
  showDetails: false,
  showTotals: false,
};

export const ENTITY_TYPE_FILTER_OPTIONS: {
  label: string;
  value: string;
  entityTypes: EntityTypeFilter[];
}[] = [
  { label: "Company", value: "company", entityTypes: ["COMPANY", "PORTFOLIO_COMPANY"] },
  { label: "Fund", value: "fund", entityTypes: ["FUND"] },
];
