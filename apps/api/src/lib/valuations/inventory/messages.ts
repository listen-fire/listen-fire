import { formatDate } from 'date-fns';

import { MessageCollector } from '../messages';
import { Holdings } from './holdings';

function logHoldings({
  messageCollector,
  holdings,
}: {
  messageCollector?: MessageCollector;
  holdings: Holdings;
}) {
  for (const [entityKey, investeeKey, entityHoldings] of holdings.entries()) {
    messageCollector?.header(
      `Holdings for ${entityKey.split(':')[1]} (${investeeKey.split(':')[1]})`,
    );
    messageCollector?.table(
      ['Asset', 'Flow', 'Other'],
      entityHoldings
        .entries()
        .map(([assetKey, assetHolding]) => [
          `${assetKey.split(':')[1]} (${assetKey.split(':')[2]})`,
          assetHolding.data.fromInvestment
            .map(
              (flow) =>
                `[${formatDate(flow.date, 'yyyy-MM-dd')}] ${flow.numAssets ? flow.numAssets.toFixed(2) : 'MISSING'}`,
            )
            .join('\n'),
          assetHolding.data.fromOtherTransactions
            .map(
              (flow) =>
                `[${formatDate(flow.date, 'yyyy-MM-dd')}] ${flow.numAssets ? flow.numAssets.toFixed(2) : 'MISSING'}`,
            )
            .join('\n'),
        ]),
    );
  }
}

export { logHoldings };
