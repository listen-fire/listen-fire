import express from 'express';

import { MB } from '../../constants';

const limit = 25 * MB;

// Meta signs the exact bytes it sent, and those bytes do not survive a
// parse → JSON.stringify round trip: Meta escapes `/` as `\/` and non-ASCII as
// `\uXXXX`, so any message carrying a link or an emoji re-serialises to
// different bytes and fails the HMAC. Keep the raw buffer for that one door.
const WHATSAPP_WEBHOOK_PATH = '/api/public/whatsapp/webhook';

const jsonBodyParser: ReturnType<typeof express.json> = express.json({
  type: 'application/json',
  limit,
  verify: (req, _res, buf) => {
    if (req.url?.startsWith(WHATSAPP_WEBHOOK_PATH)) {
      (req as unknown as { rawBody?: Buffer }).rawBody = buf;
    }
  },
});

const urlencodedBodyParser: ReturnType<typeof express.json> = express.urlencoded({
  type: 'application/x-www-form-urlencoded',
  extended: true,
  limit,
});

export { jsonBodyParser, urlencodedBodyParser };
