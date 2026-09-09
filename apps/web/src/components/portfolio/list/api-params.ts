import type { PortfolioConfig, PortfolioFilter } from "./types";

/** Every `investments` procedure takes the same filter shape — built once
 *  here so the six call sites (list, totals, year/country options, both
 *  exports) can't drift from each other. */
export function toApiFilter(filter: PortfolioFilter) {
  return {
    name: filter.name ?? undefined,
    portfolioIds: filter.portfolioIds.length ? filter.portfolioIds : undefined,
    fromDate: filter.fromDate ?? undefined,
    toDate: filter.toDate ?? undefined,
    raisedFrom: filter.raisedFrom ?? undefined,
    raisedTo: filter.raisedTo ?? undefined,
    coInvestors: filter.coInvestors.length ? filter.coInvestors : undefined,
    themes: filter.themes.length ? filter.themes : undefined,
    geos: filter.geos.length ? filter.geos : undefined,
    entityTypes: filter.entityTypes.length ? filter.entityTypes : undefined,
  };
}

/** `showDetails` on the wire means "include description/themes/latest_round
 *  in the row" — always requested so the client can expand a row locally
 *  without a refetch; `config.showDetails` only gates rendering. */
export function toApiConfig(config: PortfolioConfig) {
  return {
    portfolioIds: config.portfolioIds.length ? config.portfolioIds : undefined,
    currency: config.currency ?? undefined,
    valuationDate: config.valuationDate ?? undefined,
    aggregation: config.aggregation,
    showDetails: true,
  };
}
