import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import { getInvestmentsValuation } from '../../../../lib/valuations/valuation';
import { rollUpHoldings } from '../../../../lib/valuations/inventory';
import { valuationsQb, teamId, internalError } from './shared';

const computeInput = z.object({
  investment_ids: z.array(z.string().uuid()).max(500).optional(),
  investor_profile_id: z.string().uuid().optional(),
  investment_profile_id: z.string().uuid().optional(),

  as_of_date: z.string().date(),
  target_currency: z.nativeEnum(CurrencyIsoCode),
  strategy: z.enum(['FIFO', 'LIFO']).default('FIFO'),
  fx_date: z.string().date().optional(),
  include_irr: z.boolean().default(false),
}).refine(
  (d) => d.investment_ids || d.investor_profile_id || d.investment_profile_id,
  { message: 'At least one of investment_ids, investor_profile_id, or investment_profile_id is required' },
);

async function resolveInvestmentIds(params: z.infer<typeof computeInput>): Promise<{ id: string; date: Date | null }[]> {
  if (params.investment_ids) {
    const qb = valuationsQb();
    const rows = await qb
      .selectFrom('investment')
      .where('investment.id', 'in', params.investment_ids)
      .where('investment.team_id', '=', teamId())
      .select(['investment.id', 'investment.invested_at'])
      .execute();
    return rows.map((r: any) => ({ id: r.id, date: r.invested_at }));
  }

  const qb = valuationsQb();
  let query = qb
    .selectFrom('investment')
    .where('investment.team_id', '=', teamId())
    .select(['investment.id', 'investment.invested_at']);

  if (params.investor_profile_id) {
    query = query.where('investment.investor_profile_id', '=', params.investor_profile_id);
  }
  if (params.investment_profile_id) {
    query = query.where('investment.investment_profile_id', '=', params.investment_profile_id);
  }

  const rows = await query.execute();
  return rows.map((r: any) => ({ id: r.id, date: r.invested_at }));
}

const computeHandler: RequestHandler = async (req, res) => {
  const parseResult = computeInput.safeParse(req.body);
  if (!parseResult.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parseResult.error.flatten() });
  }

  const params = parseResult.data;
  const asOfDate = new Date(params.as_of_date);
  const fxDate = params.fx_date ? new Date(params.fx_date) : asOfDate;

  try {
    const investments = await resolveInvestmentIds(params);
    if (investments.length === 0) {
      return res.status(200).json({
        data: [],
        meta: {
          as_of_date: params.as_of_date,
          fx_date: params.fx_date ?? params.as_of_date,
          target_currency: params.target_currency,
          strategy: params.strategy,
          investment_count: 0,
        },
      });
    }

    // Compute valuations per investment
    const results = await Promise.all(
      investments.map(async (inv) => {
        const val = await getInvestmentsValuation({
          investments: [inv],
          asOfDate,
          fxDate,
          strategy: params.strategy,
          targetCurrency: params.target_currency,
        });

        const invested = val.investedTransactionDateValue;
        const totalVal = val.totalValuationDateValue;

        const moic = invested ? totalVal / invested : null;
        const gain = invested != null ? totalVal - invested : null;
        const gainPct = invested ? gain! / invested : null;

        return {
          investment_id: inv.id,
          invested: {
            transaction_date_value: val.investedTransactionDateValue,
            valuation_date_value: val.investedValuationDateValue,
          },
          unrealized: {
            transaction_date_value: val.unrealizedTransactionDateValue,
            valuation_date_value: val.unrealizedValuationDateValue,
          },
          realized: {
            // These two stay mixed-tense single-FX-basis views, kept for FX
            // attribution. `current_value` is the realised figure proper: cash
            // and only cash, each payment at the rate it arrived at. It and
            // `retained` are what `total.valuation_date_value` and `moic` are
            // built from.
            transaction_date_value: val.realizedTransactionDateValue,
            valuation_date_value: val.realizedValuationDateValue,
            current_value: val.realizedCashTransactionDateValue,
          },
          total: {
            transaction_date_value: val.totalTransactionDateValue,
            valuation_date_value: val.totalValuationDateValue,
          },
          moic,
          gain,
          gain_pct: gainPct,
          irr: null as number | null,
        };
      }),
    );

    // TODO: IRR computation via `irr` package when include_irr is true
    // Would extract cash flows from rollUpHoldings() per investment,
    // append terminal unrealized value at as_of_date, and compute.

    return res.status(200).json({
      data: results,
      meta: {
        as_of_date: params.as_of_date,
        fx_date: params.fx_date ?? params.as_of_date,
        target_currency: params.target_currency,
        strategy: params.strategy,
        investment_count: investments.length,
      },
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const computeRouter: ReturnType<typeof Router> = Router();
computeRouter.post('/', computeHandler);

export { computeRouter };
