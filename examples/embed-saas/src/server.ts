// The SaaS's HTTP face, plain node:http. A customer is created with its CRM
// API key and the fields it defines on a company; it saves movements (checked
// on save); creating a company in its CRM fires every movement that listens
// for `company.created`.
//
//   POST /customers                         { tenant, apiKey, fields? }  fields: [{ name, options? }]
//   PUT  /customers/:tenant/movements/:name  the movement's source, as text
//   POST /customers/:tenant/companies        { Name } → the company, and the runs it fired
//   GET  /customers/:tenant/companies
//   POST /tick                               step on every parked run whose time has come

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { companyCreated, type FieldDefinition } from './crm';
import { Embedding } from './embedding';
import { modelsFromEnv } from './models';

export function saasServer(embedding: Embedding): Server {
  return createServer((req, res) => {
    handle(embedding, req).then(
      ([status, body]) => send(res, status, body),
      (error: unknown) => send(res, 500, { error: error instanceof Error ? error.message : String(error) }),
    );
  });
}

async function handle(embedding: Embedding, req: IncomingMessage): Promise<[number, unknown]> {
  const path = (req.url ?? '/').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
  const body = await readBody(req);
  if (req.method === 'POST' && path.length === 1 && path[0] === 'customers') {
    const { tenant, apiKey, fields } = json(body);
    if (typeof tenant !== 'string' || typeof apiKey !== 'string') return [400, { error: 'expected { tenant, apiKey, fields? }' }];
    await embedding.addCustomer(tenant, apiKey, fieldDefinitions(fields));
    return [201, { tenant }];
  }
  if (req.method === 'POST' && path.length === 1 && path[0] === 'tick') return [200, { runs: await embedding.tick() }];
  if (path[0] !== 'customers' || path.length < 3) return [404, { error: 'not found' }];
  const tenant = path[1];
  if (req.method === 'PUT' && path[2] === 'movements' && path.length === 4) {
    const answer = await embedding.save(tenant, path[3], body);
    return [answer.saved ? 200 : 422, answer];
  }
  if (path[2] === 'companies' && path.length === 3) {
    if (req.method === 'GET') return [200, embedding.companies.list(tenant)];
    if (req.method === 'POST') {
      const fields = Object.fromEntries(Object.entries(json(body)).filter((field): field is [string, string] => typeof field[1] === 'string'));
      if (fields.Name === undefined) return [400, { error: 'expected { Name, … }' }];
      const company = embedding.companies.add(tenant, fields);
      return [201, { company, runs: await embedding.fire(tenant, companyCreated(company)) }];
    }
  }
  return [404, { error: 'not found' }];
}

/** The `fields` of a new customer: `[{ name, options? }]`, anything else ignored. */
function fieldDefinitions(raw: unknown): FieldDefinition[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((field: unknown) => {
    const { name, options } = Object.fromEntries(Object.entries(Object(field)));
    if (typeof name !== 'string') return [];
    return [{ name, ...(Array.isArray(options) ? { options: options.filter((o): o is string => typeof o === 'string') } : {}) }];
  });
}

function json(body: string): Record<string, unknown> {
  const parsed: unknown = body === '' ? {} : JSON.parse(body);
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : {};
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

if (require.main === module) {
  const port = Number(process.env.PORT ?? 3700);
  saasServer(new Embedding({ models: modelsFromEnv(process.env) })).listen(port, () => {
    process.stdout.write(`embed-saas listening on http://127.0.0.1:${port}\n`);
  });
}
