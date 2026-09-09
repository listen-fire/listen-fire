import { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import { currentContext } from '../../../../services/context';
import { applyMarkdown } from '../../../../lib/valuations/commands/markdown';
import {
  applyInvestment,
  applyInvestmentInput,
  resolveInvestmentEntities,
} from '../../../../lib/valuations/commands/investment';
import { applyPrice, applyPriceInput } from '../../../../lib/valuations/commands/price';
import { applyRound, applyRoundInput, resolveRoundEntities } from '../../../../lib/valuations/commands/round';
import { applyWindDown, applyWindDownInput } from '../../../../lib/valuations/commands/wind_down';
import { applyShareSplit, applyShareSplitInput } from '../../../../lib/valuations/commands/share_split';
import { applyDividends, applyDividendsInput } from '../../../../lib/valuations/commands/dividends';
import {
  applyFundDistribution,
  applyFundDistributionInput,
} from '../../../../lib/valuations/commands/fund_distribution';
import { applyFundDrawdown, applyFundDrawdownInput } from '../../../../lib/valuations/commands/fund_drawdown';
import { internalError } from './shared';

const addMarkdownInput = z.object({
  companyId: z.string().uuid(),
  date: z.string(),
  percentage: z.number(),
  note: z.string().optional(),
});

const addMarkdownHandler: RequestHandler = async (req, res) => {
  const parsed = addMarkdownInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  try {
    await currentContext().enterTransaction();
    const receipt = await applyMarkdown(parsed.data);
    return res.status(201).json({ data: receipt });
  } catch (err) {
    return internalError(res, err);
  }
};

const addInvestmentHandler: RequestHandler = async (req, res) => {
  const parsed = applyInvestmentInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  try {
    const resolved = await resolveInvestmentEntities(parsed.data);
    await currentContext().enterTransaction();
    const receipt = await applyInvestment(resolved);
    return res.status(201).json({ data: receipt });
  } catch (err) {
    return internalError(res, err);
  }
};

const addPriceHandler: RequestHandler = async (req, res) => {
  const parsed = applyPriceInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  try {
    await currentContext().enterTransaction();
    const receipt = await applyPrice(parsed.data);
    return res.status(201).json({ data: receipt });
  } catch (err) {
    return internalError(res, err);
  }
};

const addRoundHandler: RequestHandler = async (req, res) => {
  const parsed = applyRoundInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  try {
    const resolved = await resolveRoundEntities(parsed.data);
    await currentContext().enterTransaction();
    const receipt = await applyRound(resolved);
    return res.status(201).json({ data: receipt });
  } catch (err) {
    return internalError(res, err);
  }
};

const addWindDownHandler: RequestHandler = async (req, res) => {
  const parsed = applyWindDownInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  try {
    await currentContext().enterTransaction();
    const receipt = await applyWindDown(parsed.data);
    return res.status(201).json({ data: receipt });
  } catch (err) {
    return internalError(res, err);
  }
};

const addShareSplitHandler: RequestHandler = async (req, res) => {
  const parsed = applyShareSplitInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  try {
    await currentContext().enterTransaction();
    const receipt = await applyShareSplit(parsed.data);
    return res.status(201).json({ data: receipt });
  } catch (err) {
    return internalError(res, err);
  }
};

const addDividendsHandler: RequestHandler = async (req, res) => {
  const parsed = applyDividendsInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  try {
    await currentContext().enterTransaction();
    const receipt = await applyDividends(parsed.data);
    return res.status(201).json({ data: receipt });
  } catch (err) {
    return internalError(res, err);
  }
};

const addFundDistributionHandler: RequestHandler = async (req, res) => {
  const parsed = applyFundDistributionInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  try {
    await currentContext().enterTransaction();
    const receipt = await applyFundDistribution(parsed.data);
    return res.status(201).json({ data: receipt });
  } catch (err) {
    return internalError(res, err);
  }
};

const addFundDrawdownHandler: RequestHandler = async (req, res) => {
  const parsed = applyFundDrawdownInput.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid request body', details: parsed.error.flatten() });
  }
  try {
    await currentContext().enterTransaction();
    const receipt = await applyFundDrawdown(parsed.data);
    return res.status(201).json({ data: receipt });
  } catch (err) {
    return internalError(res, err);
  }
};

const commandsRouter: ReturnType<typeof Router> = Router();
commandsRouter.post('/add-markdown', addMarkdownHandler);
commandsRouter.post('/add-investment', addInvestmentHandler);
commandsRouter.post('/add-price', addPriceHandler);
commandsRouter.post('/add-round', addRoundHandler);
commandsRouter.post('/add-wind-down', addWindDownHandler);
commandsRouter.post('/add-share-split', addShareSplitHandler);
commandsRouter.post('/add-dividends', addDividendsHandler);
commandsRouter.post('/add-fund-distribution', addFundDistributionHandler);
commandsRouter.post('/add-fund-drawdown', addFundDrawdownHandler);
export { commandsRouter };
