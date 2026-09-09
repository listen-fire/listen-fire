import { currentContext } from '../../services/context';
import { getQb, getValuationsQb } from '../kysely';
import { LegalEntityId } from '../../generated/kysely/valuations/LegalEntity';
import { TeamId } from '../../generated/kysely/core/Team';
import { EventId } from '../../generated/kysely/valuations/Event';

async function addInvestmentAndTransaction({
  investingEntity,
  targetEntityId,
  investmentDate,
  eventId,
}: {
  investingEntity: string;
  targetEntityId: string;
  investmentDate: Date;
  eventId?: string | null;
}) {
  const ctx = currentContext();
  const investment = await getValuationsQb(['investment'])
    .insertInto('investment')
    .values({
      investor_profile_id: investingEntity as LegalEntityId,
      investment_profile_id: targetEntityId as LegalEntityId,
      invested_at: investmentDate,
      event_id: eventId as EventId,
      team_id: ctx.user.teamId as TeamId,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  // Create the investment transaction
  const transaction = await getValuationsQb(['transaction'])
    .insertInto('transaction')
    .values({
      event_id: eventId as EventId,
      investment_id: investment.id,
      close_date: investmentDate,
      team_id: ctx.user.teamId as TeamId,
    })
    .returning(['id'])
    .executeTakeFirstOrThrow();

  return { investment, transaction };
}

export { addInvestmentAndTransaction };
