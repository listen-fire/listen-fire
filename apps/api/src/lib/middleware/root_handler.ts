import { RequestHandler } from 'express';

const rootHandler: RequestHandler = (req, res) => {
  res.status(200);
  if (req.method === 'GET') {
    res.send('OK');
  } else {
    // No body for HEAD requests
    res.end();
  }
};

export { rootHandler };
