/**
 * Filter/config <-> querystring codec, ported from apps/app's PortfolioList
 * index.tsx (serializeFiltersConfigToQuery / parseFiltersConfigFromQuery).
 * Key names are kept verbatim so links minted before this port keep
 * filtering the same way.
 */

import {
  DEFAULT_CONFIG,
  DEFAULT_FILTER,
  type EntityTypeFilter,
  type Grouping,
  type PortfolioConfig,
  type PortfolioFilter,
} from "./types";
import { CurrencyIsoCode } from "#trpc";

function encodeList(list: string[]): string {
  return list.map((v) => encodeURIComponent(v)).join(",");
}

function decodeList(str: string | null): string[] {
  if (!str) return [];
  return str.split(",").map((v) => decodeURIComponent(v));
}

export function parsePortfolioQuery(params: URLSearchParams): {
  filter: PortfolioFilter;
  config: PortfolioConfig;
} {
  const filter: PortfolioFilter = {
    fromDate: params.get("fromDate") || null,
    toDate: params.get("toDate") || null,
    raisedFrom: params.get("raisedFrom") || null,
    raisedTo: params.get("raisedTo") || null,
    portfolioIds: decodeList(params.get("portfolioIds")),
    coInvestors: decodeList(params.get("coInvestors")),
    name: params.get("name") || null,
    grouping: (params.get("grouping") as Grouping) || DEFAULT_FILTER.grouping,
    themes: decodeList(params.get("themes")),
    geos: decodeList(params.get("geos")),
    entityTypes: decodeList(params.get("entityTypes")) as EntityTypeFilter[],
  };

  const config: PortfolioConfig = {
    portfolioIds: decodeList(params.get("cfgPortfolioIds")),
    currency: (params.get("currency") as CurrencyIsoCode) || DEFAULT_CONFIG.currency,
    valuationDate: params.get("valuationDate") || null,
    aggregation: (params.get("aggregation") as PortfolioConfig["aggregation"]) || "company",
    showDetails: params.get("showDetails") === "1",
    showTotals: params.get("showTotals") === "1",
  };

  return { filter, config };
}

export function serializePortfolioQuery(
  current: URLSearchParams,
  filter: PortfolioFilter,
  config: PortfolioConfig,
): string {
  const params = new URLSearchParams(current);

  filter.fromDate ? params.set("fromDate", filter.fromDate) : params.delete("fromDate");
  filter.toDate ? params.set("toDate", filter.toDate) : params.delete("toDate");
  filter.raisedFrom ? params.set("raisedFrom", filter.raisedFrom) : params.delete("raisedFrom");
  filter.raisedTo ? params.set("raisedTo", filter.raisedTo) : params.delete("raisedTo");
  filter.portfolioIds.length
    ? params.set("portfolioIds", encodeList(filter.portfolioIds))
    : params.delete("portfolioIds");
  filter.coInvestors.length
    ? params.set("coInvestors", encodeList(filter.coInvestors))
    : params.delete("coInvestors");
  filter.name ? params.set("name", filter.name) : params.delete("name");
  filter.grouping ? params.set("grouping", filter.grouping) : params.delete("grouping");
  filter.themes.length ? params.set("themes", encodeList(filter.themes)) : params.delete("themes");
  filter.geos.length ? params.set("geos", encodeList(filter.geos)) : params.delete("geos");
  filter.entityTypes.length
    ? params.set("entityTypes", encodeList(filter.entityTypes))
    : params.delete("entityTypes");

  config.portfolioIds.length
    ? params.set("cfgPortfolioIds", encodeList(config.portfolioIds))
    : params.delete("cfgPortfolioIds");
  config.currency ? params.set("currency", config.currency) : params.delete("currency");
  config.valuationDate
    ? params.set("valuationDate", config.valuationDate)
    : params.delete("valuationDate");
  config.aggregation ? params.set("aggregation", config.aggregation) : params.delete("aggregation");
  config.showDetails ? params.set("showDetails", "1") : params.delete("showDetails");
  config.showTotals ? params.set("showTotals", "1") : params.delete("showTotals");

  return params.toString();
}
