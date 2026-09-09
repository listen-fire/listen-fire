import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import CurrencyIsoCode from '../../../../generated/kysely/valuations/CurrencyIsoCode';
import { queryValuations } from '../../../../lib/valuations/query';
import { internalError } from './shared';

/**
 * The valuation query surface over HTTP — the same atoms the tRPC
 * `valuations.query` answers, in this API's snake_case idiom.
 *
 * Read-only and additive: it adds a dimension endpoint next to `/compute`'s
 * fixed projection rather than changing anything already published. `/compute`
 * answers "what is this investment worth"; this answers "sum these lots, sliced
 * this way" — invested is cash paid, full realised is cash received, direct
 * retained is degree-0 held value, acquirer exposure is held value grouped by
 * tracked entity.
 *
 * GET because it is a pure read of a computed view: filters ride the query
 * string so a result is a URL. Lists arrive comma-separated, dates as ISO.
 *
 * Tense is fixed, never a parameter: cash converts at the rate on the day it
 * moved and never moves again; held positions are always marked at the analysis
 * date. That is why there is no `fx_date` here where `/compute` still has one.
 */

const csv = (name: string) =>
  z
    .string()
    .optional()
    .transform((value) =>
      value === undefined
        ? undefined
        : value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
    )
    .refine((ids) => ids === undefined || ids.length > 0, {
      message: `${name} must name at least one value`,
    });

/** The wire spells dimensions in this surface's casing; the engine's are camel. */
const groupDimensionByParam = {
  company: 'company',
  investment: 'investment',
  investing_entity: 'investingEntity',
  round: 'round',
  degree: 'degree',
  asset: 'asset',
  tracked_entity: 'trackedEntity',
} as const;

type GroupParam = keyof typeof groupDimensionByParam;

const queryInput = z.object({
  investment_ids: csv('investment_ids'),
  invested_from: z.string().date().optional(),
  invested_to: z.string().date().optional(),
  round_id: z.string().uuid().optional(),
  investing_entity_ids: csv('investing_entity_ids'),
  investee_entity_ids: csv('investee_entity_ids'),

  degree: z.coerce.number().int().min(0).optional(),
  degree_min: z.coerce.number().int().min(0).optional(),
  degree_max: z.coerce.number().int().min(0).optional(),

  leaf_type: z.enum(['cash', 'held']).optional(),
  cash_sign: z.enum(['paid', 'received']).optional(),
  fact_from: z.string().date().optional(),
  fact_to: z.string().date().optional(),

  as_of_date: z.string().date().optional(),
  group_by: csv('group_by').refine(
    (parts) => parts === undefined || parts.every((part) => part in groupDimensionByParam),
    { message: `group_by accepts: ${Object.keys(groupDimensionByParam).join(', ')}` },
  ),

  currency: z.nativeEnum(CurrencyIsoCode),
  strategy: z.enum(['FIFO', 'LIFO']).optional(),
});

const queryHandler: RequestHandler = async (req, res) => {
  const parsed = queryInput.safeParse(req.query);
  if (!parsed.success) {
    return res
      .status(400)
      .json({ error: 'invalid_request', details: parsed.error.flatten() });
  }

  const params = parsed.data;
  const investments = {
    ids: params.investment_ids,
    investedFrom: params.invested_from ? new Date(params.invested_from) : undefined,
    investedTo: params.invested_to ? new Date(params.invested_to) : undefined,
    roundId: params.round_id,
    investingEntityIds: params.investing_entity_ids,
    investeeEntityIds: params.investee_entity_ids,
  };
  const hasSelector = Object.values(investments).some((value) => value !== undefined);

  const degree =
    params.degree !== undefined
      ? { eq: params.degree }
      : params.degree_min !== undefined || params.degree_max !== undefined
        ? { min: params.degree_min, max: params.degree_max }
        : undefined;

  const factWindow =
    params.fact_from || params.fact_to
      ? {
          from: params.fact_from ? new Date(params.fact_from) : undefined,
          to: params.fact_to ? new Date(params.fact_to) : undefined,
        }
      : undefined;

  try {
    const result = await queryValuations({
      investments: hasSelector ? investments : undefined,
      degree,
      leafType: params.leaf_type,
      cashSign: params.cash_sign,
      factWindow,
      asOfDate: params.as_of_date ? new Date(params.as_of_date) : undefined,
      groupBy: params.group_by?.map((part) => groupDimensionByParam[part as GroupParam]),
      currency: params.currency,
      strategy: params.strategy,
    });

    return res.status(200).json({
      data: result.rows.map((row) => ({
        group_key: {
          company: row.groupKey.company,
          investment: row.groupKey.investment,
          investing_entity: row.groupKey.investingEntity,
          round: row.groupKey.round,
          degree: row.groupKey.degree,
          asset: row.groupKey.asset,
          tracked_entity: row.groupKey.trackedEntity,
        },
        cash_paid: row.cashPaid,
        cash_received: row.cashReceived,
        held_value: row.heldValue,
        lot_count: row.lotCount,
      })),
      meta: {
        currency: result.currency,
        as_of_date: result.asOfDate.toISOString().slice(0, 10),
        row_count: result.rows.length,
        // A missing price is reported, never counted as zero — an unpriced
        // holding is an unknown, not an empty one.
        warnings: result.warnings,
      },
    });
  } catch (err) {
    return internalError(res, err);
  }
};

const queryRouter: ReturnType<typeof Router> = Router();
queryRouter.get('/', queryHandler);

export { queryRouter };
