import CurrencyIsoCode from '../../generated/kysely/valuations/CurrencyIsoCode';
import { currentContext } from '../../services/context';
import { getQb, getValuationsQb } from '../kysely';
import ValuationType from '../../generated/kysely/valuations/ValuationType';
import AssetType from '../../generated/kysely/valuations/AssetType';
import EventType from '../../generated/kysely/valuations/EventType';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../generated/kysely/core/Team';
import EquityRoundType from '../../generated/kysely/valuations/EquityRoundType';

async function getOrCreateEvent({
  targetEntityId,
  roundName,
  investmentCurrency,
  investmentDate,
  totalRaisedAmount,
  totalRaisedCurrency,
  valuationAmount,
  valuationCurrency,
  valuationType,
  investmentType,
}: {
  targetEntityId: string;
  roundName: string;
  investmentCurrency: CurrencyIsoCode;
  investmentDate: string;
  totalRaisedAmount: number | null;
  totalRaisedCurrency?: CurrencyIsoCode;
  valuationAmount: number | null;
  valuationCurrency?: CurrencyIsoCode;
  valuationType?: ValuationType;
  investmentType?: AssetType;
}) {
  const ctx = currentContext();

  const existing = await getValuationsQb(['event'])
    .selectFrom('event')
    .where('name', '=', roundName)
    .where('legal_entity_id', '=', targetEntityId as LegalEntityId)
    .where('date', '=', new Date(investmentDate))
    .where('type', '=', EventType.INVESTMENT_ROUND)
    .where('team_id', '=', ctx.user.teamId as TeamId)
    .select('id')
    .executeTakeFirst();

  if (existing) {
    return existing;
  }

  // Use the same currency for all valuation-related fields if not specified
  const defaultCurrency = investmentCurrency;

  // Create the investment round
  const event = await getValuationsQb(['event'])
    .insertInto('event')
    .values({
      legal_entity_id: targetEntityId as LegalEntityId,
      name: roundName,
      type: EventType.INVESTMENT_ROUND,
      date: new Date(investmentDate),
      team_id: ctx.user.teamId as TeamId,
      round_type: EquityRoundType.UNKNOWN,
      raised_amount: totalRaisedAmount,
      raised_currency: totalRaisedCurrency || defaultCurrency,
      valuation: valuationAmount,
      valuation_currency: valuationCurrency || defaultCurrency,
      valuation_type: valuationType || ValuationType.POST_MONEY, // Default to POST_MONEY as per memory
      asset_type: investmentType,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return event;
}

export { getOrCreateEvent };
