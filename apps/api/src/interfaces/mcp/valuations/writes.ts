// Write tools — one flat tool per funding-tab mutation, each proxying its
// `views.portfolio.company` tRPC procedure in-process. All carry destructiveHint.

import { procedureTools, type ProcedureToolConfig } from '../procedure_tools';

const COMPANY = 'views.portfolio.company.';

const WRITE_CONFIGS: Omit<ProcedureToolConfig, 'readOnly'>[] = [
  // Add actions
  { tool: 'addInvestment', procedure: 'addInvestment', title: 'Add an investment', description: 'Record a new investment (equity, convertible, SPV, or secondary) into a company, optionally minting a new company/SPV/seller and co-investors.' },
  { tool: 'addRound', procedure: 'addRound', title: 'Add a round', description: 'Record a funding round for a company (name, date, valuation, price per share, total raised, investors).' },
  { tool: 'addAcquisition', procedure: 'addAcquisition', title: 'Add an acquisition', description: 'Record a company being acquired: the acquirer, and per-fund the assets sold and the cash/equity consideration received.' },
  { tool: 'addSecondarySale', procedure: 'addSecondarySale', title: 'Add a secondary sale', description: 'Record shares sold on the secondary market to a buyer, per transaction (asset, number of shares, price per share, seller).' },
  { tool: 'addDividends', procedure: 'addDividends', title: 'Add dividends', description: 'Record a dividend paid to a fund from a company.' },
  { tool: 'addWindDown', procedure: 'addLiquidation', title: 'Add a wind down', description: 'Record a company wind down / liquidation: per investor the assets received.' },
  { tool: 'addPrice', procedure: 'addPrice', title: 'Add a price', description: 'Record a price for a company (optionally for a specific asset/share class), in a currency and on a date.' },
  { tool: 'addMarkdown', procedure: 'addMarkdown', title: 'Add a markdown', description: "Record a markdown of a company's value by a percentage on a date." },
  { tool: 'addShareSplit', procedure: 'addShareSplit', title: 'Add a share split', description: 'Record a share split for a company by a multiple on a date.' },
  { tool: 'addFundDrawdown', procedure: 'addFundDrawdown', title: 'Add a fund drawdown', description: 'Record a capital drawdown against a fund and its outstanding commitment.' },
  { tool: 'addFundDistribution', procedure: 'addFundDistribution', title: 'Add a fund distribution', description: 'Record a distribution from a company to a fund.' },
  // Edit / convert
  { tool: 'updateRound', procedure: 'updateRoundInfo', title: 'Update a round', description: 'Edit a round event: name, date, valuation, price per share, round type, and investors.' },
  { tool: 'updatePrice', procedure: 'updatePrice', title: 'Update a price', description: 'Edit an existing price (date, amount, currency).' },
  { tool: 'updateTransaction', procedure: 'updateAssetTransfer', title: 'Update transactions', description: 'Edit one or more asset transfers on a transaction (amounts, currency, asset, convertible terms).', arrayArg: 'transfers' },
  { tool: 'updateCompany', procedure: 'updateCompanyInfo', title: 'Update company info', description: 'Edit a company\'s basic details (name, description, country, legal name, website, other names, status).' },
  { tool: 'convertConvertible', procedure: 'convertTransaction', title: 'Convert a convertible', description: 'Convert a convertible transaction into equity (conversion date, price, shares, class, interest).' },
  { tool: 'addAcquisitionProceeds', procedure: 'addCashflowsToTransaction', title: 'Add acquisition proceeds', description: 'Attach a cashflow (amount, date, currency) to an acquisition transaction.' },
  // Delete
  { tool: 'deleteEvent', procedure: 'removeEvent', title: 'Delete an event', description: 'Delete a round or other event by id.' },
  { tool: 'deletePrice', procedure: 'removePrice', title: 'Delete a price', description: 'Delete a price by id.' },
  { tool: 'deleteMarkdown', procedure: 'removeMarkdown', title: 'Delete a markdown', description: 'Delete a markdown by id.' },
  { tool: 'deleteNote', procedure: 'deleteNote', title: 'Delete a note', description: 'Delete a note by id.' },
  // Co-investors
  { tool: 'addInvestor', procedure: 'addInvestorToEvent', title: 'Add an investor', description: 'Add a co-investor to a round event (existing or newly minted).' },
  { tool: 'removeInvestor', procedure: 'removeInvestorFromEvent', title: 'Remove an investor', description: 'Remove a co-investor from a round event.' },
  // Notes
  { tool: 'addPriceNote', procedure: 'addPriceNote', title: 'Add a price note', description: 'Attach a note to a price.' },
  { tool: 'addEventNote', procedure: 'addEventNote', title: 'Add an event note', description: 'Attach a note to an event.' },
  { tool: 'addInvestmentNote', procedure: 'addInvestmentNote', title: 'Add an investment note', description: 'Attach a note to an investment.' },
  { tool: 'addTransactionNote', procedure: 'addTransactionNote', title: 'Add a transaction note', description: 'Attach a note to a transaction.' },
];

const valuationsWriteTools = procedureTools(
  WRITE_CONFIGS.map((c) => ({ ...c, readOnly: false })),
  COMPANY,
);

export { valuationsWriteTools };
