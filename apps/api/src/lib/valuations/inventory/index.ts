import { formatDate } from 'date-fns';

import {
  AssetKey,
  AssetTransfer,
  getInvestingEntityKey,
  getInvesteeEntityKey,
  getAssetKey,
  InvesteeEntityKey,
  InvestingEntityKey,
} from './types';
import { MessageCollector } from '../messages';
import {
  CanonicalInvestee,
  getAssetHolderIdsForInvestments,
  getAssetsAndTransactionsForInvestments,
  recursiveGetTransactionsForAssets,
} from './data';
import { logHoldings } from './messages';
import { handleError } from '../../errors';
import { neverAsAny } from '../../utils/types';
import { AssetHolding, Holdings } from './holdings';
import {
  TransactionFlow,
  TransactionFlowClassification,
  TransactionFlowsByEntity,
  classifyTransactionFlow,
} from './transactionFlows';
import { getAssetExchangeProportion, getZeroValueAssetTypes } from './assetExchange';
import { Lot, provenanceFromDisposals, provenanceFromHoldings, toLots } from './lots';
import { getAssetTrackedEntities } from '../trackedEntities';

type Investee = { id: string; name: string };

/**
 * Where a pure-cash one-way — a dividend, a liquidation payout — belongs when no
 * transfer in it names an asset we track. Cash carries no canonical investee of
 * its own, so the fallback would file it under the entity the walk found it
 * through: the payer. That is right while the payer IS the company we invested
 * in, and wrong the moment it isn't — an acquirer's dividend lands in the
 * acquirer's own empty bucket, attributed to nothing and invisible to every
 * valuation. The payment is on rights arising from a holding, so it belongs in
 * the bucket that holding lives in, where the ONE_WAY attribution can see it.
 */
function oneWayCashInvestee({
  transfers,
  dueToRightsFromAssetId,
  canonicalInvestee,
  investeeByIssuer,
}: {
  transfers: AssetTransfer['transfers'];
  dueToRightsFromAssetId: string | null;
  canonicalInvestee: CanonicalInvestee;
  investeeByIssuer: Map<string, Investee>;
}): Investee | undefined {
  if (!transfers.length || !transfers.every((t) => t.assetType === 'CURRENCY')) return undefined;

  const named = dueToRightsFromAssetId ? canonicalInvestee.get(dueToRightsFromAssetId) : undefined;
  if (named) return named;

  return transfers
    .flatMap((transfer) => transfer.investees)
    .map((investee) => investeeByIssuer.get(investee.id))
    .find((bucket): bucket is Investee => !!bucket);
}

type ClassifiedTransactionFlow = TransactionFlow & {
  date: Date;
  eventId: string | null;
  convertedToId: string | null;
  dueToRightsFromAssetId: string | null;
  investingEntityKey: InvestingEntityKey;
  investeeEntityKey: InvesteeEntityKey;
  classification: TransactionFlowClassification;
};

async function rollUpHoldings({
  investmentIds,
  asOfDate = new Date(),
  strategy = 'FIFO', // LIFO is not permitted by IFRS, so use FIFO by default
  messageCollector,
}: {
  investmentIds: string[];
  asOfDate?: Date;
  strategy?: 'LIFO' | 'FIFO';
  messageCollector?: MessageCollector;
}): Promise<{ holdings: Holdings; classifiedTransactionFlows: ClassifiedTransactionFlow[] }> {
  const investmentAssetHolders = await getAssetHolderIdsForInvestments({
    investmentIds,
  });

  // Get initial transactions and assets from the investment
  const { assetIds, transactionIds } = await getAssetsAndTransactionsForInvestments({
    investmentIds,
    asOfDate,
  });

  // Recursively get all related transactions. `canonicalInvestee` records, for
  // each tracked asset, the company under whose holdings its flows are keyed —
  // consideration received in a swap inherits the disposed asset's investee so
  // an acquired investment's value doesn't fragment across the acquirer.
  const canonicalInvestee: CanonicalInvestee = new Map();
  const orderedTransactions: AssetTransfer[] = await recursiveGetTransactionsForAssets({
    investmentIds,
    assetIds: Array.from(assetIds),
    assets: assetIds,
    transactions: new Set(),
    asOfDate,
    canonicalInvestee,
  });

  // Which bucket an issuer's assets ended up in. Read only by the cash
  // anchoring below: a payment names its payer, never a holding, so this is the
  // one link from "who paid" back to "where what they paid on lives".
  const investeeByIssuer = new Map<string, Investee>();
  for (const { transfers } of orderedTransactions) {
    for (const { assetId, assetIssuerId } of transfers) {
      if (!assetIssuerId || investeeByIssuer.has(assetIssuerId)) continue;
      const investee = canonicalInvestee.get(assetId);
      if (investee) investeeByIssuer.set(assetIssuerId, investee);
    }
  }

  const holdings = new Holdings();

  messageCollector?.header('Transaction Classification');
  const tableHeaders = [
    'Investor',
    'Date',
    'Classification',
    '% due to Investment',
    'Inflows',
    'Outflows',
  ];
  const messageRows: string[][] = [];

  const classifiedTransactionFlows: ClassifiedTransactionFlow[] = [];

  // Process transactions in chronological order
  for (const {
    transaction_id: transactionId,
    investment_id: investmentId,
    convertedToId,
    due_to_rights_from_asset_id: dueToRightsFromAssetId,
    transfers,
    close_date: date,
    event_id: eventId,
  } of orderedTransactions) {
    // Group transfers by investing entity to handle exchanges
    const transactionFlowsByEntity = new TransactionFlowsByEntity();

    // All of a transaction's flows are keyed under a single investee: the
    // canonical investee of whichever tracked asset it touches (so a swap's
    // consideration and its later disposals share the acquired company's
    // bucket). Fall back to the transfer's own issuer when none is tracked.
    const anchorInvestee =
      transfers.map((t) => canonicalInvestee.get(t.assetId)).find((v): v is Investee => !!v) ??
      oneWayCashInvestee({
        transfers,
        dueToRightsFromAssetId,
        canonicalInvestee,
        investeeByIssuer,
      });

    // First, group all transfers by entity
    for (const transfer of transfers) {
      const { investingEntityId, investingEntityName, investees } = transfer;
      if (!investingEntityId) continue;
      // Skip transfers that aren't to the entities whose investments we're looking at
      if (!investmentAssetHolders.includes(investingEntityId)) continue;

      // Several investees is only a problem when nothing else says which bucket
      // this belongs in — then `investees[0]` is an arbitrary pick. Discovery
      // legitimately reaches one transaction through several tracked assets (a
      // company's payout is found through both a direct holding and an SPV over
      // it), and the anchor decides between them.
      if (!anchorInvestee && investees.length !== 1) {
        handleError(
          `Non-single investee entity not supported for ${transactionId}: ${investees.map((i) => `${i.id}: ${i.name}`).join(', ')}`,
        );
      }

      const investee = anchorInvestee ?? investees[0];

      transactionFlowsByEntity.addFlow(
        getInvestingEntityKey({
          investingEntityId,
          investingEntityName,
        }),
        getInvesteeEntityKey({
          investeeEntityId: investee.id,
          investeeEntityName: investee.name,
        }),
        {
          transactionId,
          investmentId,
          ...transfer,
        },
      );
    }

    // Process each entity's transfers
    for (const [
      investingEntityKey,
      entityTransactionFlowsByInvestee,
    ] of transactionFlowsByEntity.entries()) {
      for (const [
        investeeEntityKey,
        transactionFlow,
      ] of entityTransactionFlowsByInvestee.entries()) {
        const assetHoldings = holdings.get(investingEntityKey, investeeEntityKey);

        const classification = classifyTransactionFlow({
          transactionFlow,
          assetIds,
          transactionIds,
          transactionId,
        });

        classifiedTransactionFlows.push({
          ...transactionFlow,
          investingEntityKey,
          investeeEntityKey,
          classification,
          convertedToId,
          dueToRightsFromAssetId,
          date,
          eventId,
        });

        // Add a log row for this transaction
        const addLogRow = (proportion: number) => {
          messageRows.push([
            investingEntityKey.split(':')[1],
            formatDate(date, 'yyyy-MM-dd'),
            classification,
            `${(proportion * 100).toFixed(0)}`,
            transactionFlow.inflows.length.toString(),
            transactionFlow.outflows.length.toString(),
          ]);
        };

        // Whatever we handed over is what the consideration came out of — the
        // causal link the lot engine reads back as degree. Recorded here, where
        // the classification already knows it, rather than re-derived later.
        const disposalProvenance = provenanceFromDisposals(transactionFlow.outflows);

        if (classification === 'CASH_INVESTMENT') {
          // Add everything to investment
          assetHoldings.proportionallyAdd({
            transactionFlow,
            investmentProportion: 1,
            date,
            inflowProvenance: disposalProvenance,
          });
          addLogRow(1);
        } else if (classification === 'NON_CASH_INVESTMENT') {
          for (const flow of transactionFlow.inflows) {
            if (flow.assetType === 'CURRENCY') {
              // Any currency recieved in an investment is due to a different investment
              assetHoldings.get(getAssetKey(flow)).add(
                {
                  numAssets: flow.numAssets,
                  date,
                  provenance: disposalProvenance,
                },
                'OTHER',
              );
            } else {
              assetHoldings.get(getAssetKey(flow)).add(
                {
                  numAssets: flow.numAssets,
                  date,
                  provenance: disposalProvenance,
                },
                'INVESTMENT',
              );
            }
          }
          for (const flow of transactionFlow.outflows) {
            if (flow.assetType === 'CURRENCY') {
              assetHoldings.get(getAssetKey(flow)).add(
                {
                  numAssets: -flow.numAssets,
                  date,
                },
                'INVESTMENT',
              );
            } else {
              assetHoldings.get(getAssetKey(flow)).add(
                {
                  numAssets: -flow.numAssets,
                  date,
                },
                'OTHER',
              );
            }
          }

          addLogRow(NaN);
        } else if (
          classification === 'ASSET_EXCHANGE' ||
          classification === 'ASSET_EXCHANGE_FOR_NEW_INVESTMENT'
        ) {
          // We disposed of a tracked asset in exchange for other assets, so the
          // consideration is the continuation of this investment's value:
          // attribute it fromInvestment in proportion to how much of the outflow
          // was ours, and let the recursion follow it onward. This holds even
          // when the consideration is an acquirer's shares recorded as their own
          // new investment (ASSET_EXCHANGE_FOR_NEW_INVESTMENT) — whether that
          // consideration counts as realised or retained is decided later by the
          // "does this asset still track the investee?" rule, not dropped here.
          // This can be partial: need to use the outflow proportions to split the inflow
          const excludeAssetTypes = getZeroValueAssetTypes(transactionFlow.outflows);

          // Record excluded outflows with 0 investment proportion
          if (excludeAssetTypes.size > 0) {
            const excludedOutflows = transactionFlow.outflows.filter((f) =>
              excludeAssetTypes.has(f.assetType),
            );
            assetHoldings.proportionallyAdd({
              transactionFlow: { ...transactionFlow, inflows: [], outflows: excludedOutflows },
              investmentProportion: 0,
              date,
            });
          }

          const includedOutflows = transactionFlow.outflows.filter(
            (f) => !excludeAssetTypes.has(f.assetType),
          );

          const investmentProportion = getAssetExchangeProportion({
            transactionFlow: { ...transactionFlow, outflows: transactionFlow.outflows },
            assetHoldings,
            strategy,
            excludeAssetTypes,
          });

          assetHoldings.proportionallyAdd({
            transactionFlow: {
              ...transactionFlow,
              outflows: includedOutflows,
            },
            investmentProportion,
            date,
            // The consideration descends from the disposals actually weighed —
            // the zero-value types dropped above carried no value to pass on.
            inflowProvenance: provenanceFromDisposals(includedOutflows) ?? disposalProvenance,
          });

          addLogRow(investmentProportion);
        } else if (classification === 'ASSET_PURCHASE') {
          if (!transactionFlow.investmentId) {
            handleError(
              `Investment ID not found for investment asset purchase - Transaction Id ${transactionFlow.transactionId}, Investee ${investeeEntityKey}`,
            );
          }

          assetHoldings.proportionallyAdd({
            transactionFlow,
            investmentProportion: 0,
            date,
            inflowProvenance: disposalProvenance,
          });

          addLogRow(0);
        } else if (classification === 'UNRELATED_ASSET_EXCHANGE') {
          // Add everything to Other
          assetHoldings.proportionallyAdd({
            transactionFlow,
            investmentProportion: 0,
            date,
            inflowProvenance: disposalProvenance,
          });

          addLogRow(0);
        } else if (classification === 'ONE_WAY_TRANSACTION') {
          // If this isn't an exchange (i.e. a dividend, share split etc.) then
          // we have to make a best guess at the causal link between the
          // holdings and transaction
          const holdingsSplit = assetHoldings.classifySplit();
          const equityHoldings = assetHoldings.getManyByType('EQUITY');
          let nonCurrencyHoldings = assetHoldings.getManyByType((type) => type !== 'CURRENCY');
          if (dueToRightsFromAssetId) {
            nonCurrencyHoldings = nonCurrencyHoldings.filter(
              ([assetKey]) => assetKey.split(':')[0] === dueToRightsFromAssetId,
            );
          }

          // The rights this payment came in on. `due_to_rights_from_asset_id`
          // names the holding outright where the source recorded it; otherwise
          // the branch's own candidate set stands in. This chooses only which
          // degree each split lands in, never how much is attributed.
          const oneWayProvenance = (candidates: (readonly [AssetKey, AssetHolding])[]) => {
            const named = dueToRightsFromAssetId
              ? candidates.filter(([assetKey]) => assetKey.split(':')[0] === dueToRightsFromAssetId)
              : [];
            return provenanceFromHoldings(named.length ? named : candidates);
          };

          if (holdingsSplit === 'INVESTMENT_ONLY') {
            // if there are no holdings in Other and some in Investment, then assign it all to Investment
            assetHoldings.proportionallyAdd({
              transactionFlow,
              investmentProportion: 1,
              date,
              inflowProvenance: oneWayProvenance(nonCurrencyHoldings),
            });

            addLogRow(1);
          } else if (equityHoldings.length > 0) {
            // if we hold equity, non-exchanges are proportional to the existing holdings
            // e.g. if we hold 100 shares of A and 200 shares of B,
            // then a dividend would be split 1:2 between A and B
            // so sum the total holdings and split the inflow based on the ratio of each holding
            const { fromInvestment, fromOther } = equityHoldings.reduce(
              (sum, [_, holding]) => ({
                fromInvestment: sum.fromInvestment + holding.sum().fromInvestment,
                fromOther: sum.fromOther + holding.sum().fromOtherTransactions,
              }),
              { fromInvestment: 0, fromOther: 0 },
            );
            const totalEquityHoldings = fromInvestment + fromOther;
            const equityProportion =
              totalEquityHoldings > 0 ? fromInvestment / totalEquityHoldings : 0;

            assetHoldings.proportionallyAdd({
              transactionFlow,
              investmentProportion: equityProportion,
              date,
              inflowProvenance: oneWayProvenance(equityHoldings),
            });

            addLogRow(equityProportion);
          } else if (nonCurrencyHoldings.length === 1) {
            // if not and there is a single non-currency asset, split the inflow based on the ratio of that asset
            const holding = nonCurrencyHoldings[0][1];
            const { fromInvestment, fromOtherTransactions } = holding.sum();
            const totalHoldings = fromInvestment + fromOtherTransactions;
            const proportion =
              Math.abs(totalHoldings) > 0 ? Math.abs(fromInvestment / totalHoldings) : 0;

            assetHoldings.proportionallyAdd({
              transactionFlow,
              investmentProportion: proportion,
              date,
              inflowProvenance: oneWayProvenance(nonCurrencyHoldings),
            });

            addLogRow(proportion);
          } else {
            // otherwise, assign it all to Other - we can't determine the ratio
            assetHoldings.proportionallyAdd({
              transactionFlow,
              investmentProportion: 0,
              date,
              inflowProvenance: oneWayProvenance(nonCurrencyHoldings),
            });

            addLogRow(0);
          }
        } else {
          throw new Error(`Unknown transaction type: ${neverAsAny(classification)}`);
        }
      }
    }
  }

  messageCollector?.table(tableHeaders, messageRows);

  logHoldings({
    messageCollector,
    holdings,
  });

  return { holdings, classifiedTransactionFlows };
}

async function getClassifiedTransactionFlows({
  investmentIds,
  asOfDate = new Date(),
  strategy = 'FIFO', // LIFO is not permitted by IFRS, so use FIFO by default
  messageCollector,
}: {
  investmentIds: string[];
  asOfDate?: Date;
  strategy?: 'LIFO' | 'FIFO';
  messageCollector?: MessageCollector;
}): Promise<ClassifiedTransactionFlow[]> {
  const { classifiedTransactionFlows } = await rollUpHoldings({
    investmentIds,
    asOfDate,
    strategy,
    messageCollector,
  });

  return classifiedTransactionFlows;
}

async function getInventoryForInvestments({
  investmentIds,
  asOfDate = new Date(),
  strategy = 'FIFO', // LIFO is not permitted by IFRS, so use FIFO by default
  messageCollector,
}: {
  investmentIds: string[];
  asOfDate?: Date;
  strategy?: 'LIFO' | 'FIFO';
  messageCollector?: MessageCollector;
}): Promise<Holdings> {
  const { holdings } = await rollUpHoldings({
    investmentIds,
    asOfDate,
    strategy,
    messageCollector,
  });

  return holdings;
}

/**
 * The roll-up's leaves, flattened: one annotated lot per attributed flow. Same
 * walk as `getInventoryForInvestments` — the tracked-entity resolution runs
 * afterwards, over the holdings it produced, so the roll-up itself is untouched.
 */
async function getLotsForInvestments({
  investmentIds,
  asOfDate = new Date(),
  strategy = 'FIFO', // LIFO is not permitted by IFRS, so use FIFO by default
  messageCollector,
}: {
  investmentIds: string[];
  asOfDate?: Date;
  strategy?: 'LIFO' | 'FIFO';
  messageCollector?: MessageCollector;
}): Promise<Lot[]> {
  const { holdings } = await rollUpHoldings({
    investmentIds,
    asOfDate,
    strategy,
    messageCollector,
  });

  const assetIds = new Set<string>();
  for (const investeeHoldings of holdings.values()) {
    for (const assetKey of investeeHoldings.keys()) {
      assetIds.add(assetKey.split(':')[0]);
    }
  }

  return toLots({
    holdings,
    trackedEntities: await getAssetTrackedEntities(Array.from(assetIds)),
  });
}

export {
  getInventoryForInvestments,
  getClassifiedTransactionFlows,
  getLotsForInvestments,
  ClassifiedTransactionFlow,
  Lot,
  rollUpHoldings,
};
