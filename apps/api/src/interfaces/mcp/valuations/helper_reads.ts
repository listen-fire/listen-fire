// Read-only helper tools — the lookups the mutation forms use to resolve the
// ids a write needs (assets, rounds, investors, entities). All readOnlyHint, so
// no access prompt.

import { procedureTools, type ProcedureToolConfig } from '../procedure_tools';

const HELPER_READ_CONFIGS: Omit<ProcedureToolConfig, 'readOnly'>[] = [
  { tool: 'getPriceAssetOptions', procedure: 'getPriceAssetOptions', title: 'List price assets', description: 'The assets/share classes of a company you can attach a price to.' },
  { tool: 'getRoundNames', procedure: 'getRoundNamesForLegalEntity', title: 'List round names', description: 'Existing round names for a company (for addInvestment / addRound).' },
  { tool: 'getAcquisitionTransactions', procedure: 'getAcquisitionTransactions', title: 'List acquisition transactions', description: 'Acquisition transactions you can attach proceeds to.' },
  { tool: 'getOutstandingCommitments', procedure: 'getOutstandingCommitments', title: 'List outstanding commitments', description: "A fund's outstanding commitments (for a drawdown)." },
  { tool: 'findInvestingEntities', procedure: 'findInvestingEntitiesByName', title: 'Find investing entities', description: 'Search your funds / investing entities by name.' },
  { tool: 'getOtherInvestors', procedure: 'getOtherInvestors', title: 'Find co-investors', description: 'Search co-investor entities by name.' },
  { tool: 'getSpvsForEntity', procedure: 'getSPVsForEntity', title: 'List SPVs', description: 'SPVs associated with an entity.' },
  { tool: 'getLegalEntities', procedure: 'getLegalEntities', title: 'Find legal entities', description: 'Search legal entities by name.' },
];

const valuationsHelperReadTools = procedureTools(
  HELPER_READ_CONFIGS.map((c) => ({ ...c, readOnly: true })),
  'views.portfolio.company.',
);

export { valuationsHelperReadTools };
