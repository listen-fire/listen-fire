import express from 'express';

import { MB } from '../../constants';

const limit = 25 * MB;

const jsonBodyParser: ReturnType<typeof express.json> = express.json({
  type: 'application/json',
  limit,
});

const urlencodedBodyParser: ReturnType<typeof express.json> = express.urlencoded({
  type: 'application/x-www-form-urlencoded',
  extended: true,
  limit,
});

export { jsonBodyParser, urlencodedBodyParser };
