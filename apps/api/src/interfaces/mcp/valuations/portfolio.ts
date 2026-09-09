// Portfolio-level tools — the companies-list ("portfolio/companies") UI as flat
// tools, proxying the views.investments.* procedures in-process. Reads are
// read-only (no access prompt). Added to the valuations connector so a single
// connection spans both the portfolio list and a company's funding detail.

import { procedureTools, type ProcedureToolConfig } from '../procedure_tools';

const INVESTMENTS = 'views.investments.';

const PORTFOLIO_CONFIGS: ProcedureToolConfig[] = [
  {
    tool: 'listPortfolioCompanies',
    procedure: 'getPortfolioInvestments',
    title: 'List portfolio companies',
    readOnly: true,
    description:
      'Every company in your portfolio with its metrics — invested, fair value, realised, MOIC, ' +
      'first-investment date — in one call, whole rather than paged. By default a company sold ' +
      'for shares in its acquirer appears as two lines: the company you bought, and the acquirer ' +
      'holding the shares (no invested figure or MOIC on that one); `lens: "investment"` keeps ' +
      'those shares on the line for the company you bought instead. Supports filters (country, ' +
      'year, raised-between, co-investors, funds), a currency and valuation date (config), ' +
      'company- or investment-level aggregation, and grouping.',
  },
  {
    tool: 'getPortfolioTotals',
    procedure: 'getPortfolioTotals',
    title: 'Get portfolio totals',
    readOnly: true,
    description: 'Aggregate totals (invested, value, realised, MOIC) across the filtered portfolio.',
  },
  {
    tool: 'getPortfolioCountries',
    procedure: 'getCountryOptions',
    title: 'List portfolio countries',
    readOnly: true,
    description: 'The country filter options present in your portfolio.',
  },
  {
    tool: 'getPortfolioYears',
    procedure: 'getYearOptions',
    title: 'List portfolio years',
    readOnly: true,
    description: 'The investment-year filter options present in your portfolio.',
  },
  {
    tool: 'updatePointOfContact',
    procedure: 'updatePointOfContact',
    title: 'Set a point of contact',
    readOnly: false,
    description: 'Set the point-of-contact user for a portfolio company.',
  },
];

const portfolioTools = procedureTools(PORTFOLIO_CONFIGS, INVESTMENTS);

export { portfolioTools };
