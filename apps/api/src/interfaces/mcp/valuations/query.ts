// The raw query tool — the degrees of freedom the list/CSV surfaces opinionate
// over, exposed directly. UI and CSV pick one grouping and one set of columns;
// this proxies views.valuations.query so an agent can pick its own.

import { procedureTools, type ProcedureToolConfig } from '../procedure_tools';

const VALUATIONS = 'views.valuations.';

const QUERY_CONFIGS: ProcedureToolConfig[] = [
  {
    tool: 'queryValuations',
    procedure: 'query',
    title: 'Query valuations',
    readOnly: true,
    description:
      "One query over the portfolio's valuation atoms — cash paid, cash received, and the value " +
      "of what's still held — filtered and grouped however you like, with no fixed columns. Group " +
      'by company for the investment view (everything filed under the company you invested in, at ' +
      'any degree, including acquirer shares from a deal); group by trackedEntity for the holdings ' +
      'view (each line is what you hold now, so acquirer shares show up under the acquirer). Cash ' +
      "is priced at the FX rate on the day it moved and never changes; what's still held is live, " +
      'priced and converted as of the date you ask for.',
  },
];

const valuationsQueryTools = procedureTools(QUERY_CONFIGS, VALUATIONS);

export { valuationsQueryTools };
