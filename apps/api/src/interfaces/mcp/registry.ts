import { z, type ZodType } from 'zod';

interface RouteEntry {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  description: string;
  domain: string;
  inputSchema?: ZodType;
  inputLocation: 'query' | 'body';
  /** Expected latency hint for the calling agent */
  latency?: 'fast' | 'medium' | 'slow';
  /** Whether this endpoint only reads data (no side effects) */
  readOnly?: boolean;
}

const routes: RouteEntry[] = [];

function registerRoute(entry: RouteEntry) {
  routes.push(entry);
}

function registerCrudRoutes(options: {
  basePath: string;
  description: string;
  domain: string;
  listSchema: ZodType;
  createSchema?: ZodType;
  updateSchema?: ZodType;
}) {
  const { basePath, description, domain, listSchema, createSchema, updateSchema } = options;

  registerRoute({
    method: 'GET',
    path: basePath,
    description: `List ${description}`,
    domain,
    inputSchema: listSchema,
    inputLocation: 'query',
  });

  registerRoute({
    method: 'GET',
    path: `${basePath}/:id`,
    description: `Get a single ${description.replace(/s$/, '')} by ID`,
    domain,
    inputLocation: 'query',
  });

  if (createSchema) {
    registerRoute({
      method: 'POST',
      path: basePath,
      description: `Create a new ${description.replace(/s$/, '')}`,
      domain,
      inputSchema: createSchema,
      inputLocation: 'body',
    });
  }

  if (updateSchema) {
    registerRoute({
      method: 'PATCH',
      path: `${basePath}/:id`,
      description: `Update a ${description.replace(/s$/, '')}`,
      domain,
      inputSchema: updateSchema,
      inputLocation: 'body',
    });
  }

  if (createSchema) {
    registerRoute({
      method: 'DELETE',
      path: `${basePath}/:id`,
      description: `Delete a ${description.replace(/s$/, '')}`,
      domain,
      inputLocation: 'body',
    });
  }
}

/** Does an actual request path (`:id` already substituted with a real value)
 *  match a registered route's path template? Segment count must agree, and
 *  every non-`:param` template segment must match literally. */
function pathMatchesTemplate(template: string, actual: string): boolean {
  const templateParts = template.split('/');
  const actualParts = actual.split('/');
  if (templateParts.length !== actualParts.length) return false;
  return templateParts.every((part, i) => part.startsWith(':') || part === actualParts[i]);
}

function matchRoute(domain: string, method: RouteEntry['method'], path: string): RouteEntry | undefined {
  return routes.find(
    (r) => r.domain === domain && r.method === method && pathMatchesTemplate(r.path, path),
  );
}

/**
 * Validate a generic `call_api` body against the target route's registered
 * schema, if the registry declares one. Unknown keys are a hard error, not
 * silently stripped — a stripped field reads to the caller as "written",
 * when it was actually dropped, which is worse than a loud failure. Routes
 * with no registered schema (or no schema on the `body` location) forward
 * unvalidated, same as before this function existed.
 */
function validateCallApiBody(
  domain: string,
  method: RouteEntry['method'],
  path: string,
  body: unknown,
): { ok: true } | { ok: false; error: string } {
  const route = matchRoute(domain, method, path);
  if (!route?.inputSchema || route.inputLocation !== 'body') {
    return { ok: true };
  }

  const schema = route.inputSchema instanceof z.ZodObject ? route.inputSchema.strict() : route.inputSchema;
  const result = schema.safeParse(body ?? {});
  if (result.success) return { ok: true };

  const unrecognized = result.error.issues.flatMap((issue) =>
    issue.code === 'unrecognized_keys' ? issue.keys : [],
  );
  const otherIssues = result.error.issues
    .filter((issue) => issue.code !== 'unrecognized_keys')
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);

  const detail = [
    unrecognized.length > 0 ? `Unrecognized field(s): ${unrecognized.join(', ')}.` : undefined,
    otherIssues.length > 0 ? otherIssues.join('; ') : undefined,
  ]
    .filter(Boolean)
    .join(' ');

  return {
    ok: false,
    error: `Invalid body for ${method} ${path}: ${detail} ${route.description}`.trim(),
  };
}

function describeRoutes(domain?: string) {
  const filtered = domain ? routes.filter((r) => r.domain === domain) : routes;

  return filtered.map((r) => {
    let input: unknown;
    if (r.inputSchema) {
      try {
        input = z.toJSONSchema(r.inputSchema);
      } catch {
        input = undefined;
      }
    }

    return {
      method: r.method,
      path: r.path,
      description: r.description,
      ...(input ? { input, input_location: r.inputLocation } : {}),
      ...(r.latency ? { latency: r.latency } : {}),
      ...(r.readOnly !== undefined ? { read_only: r.readOnly } : {}),
    };
  });
}

export { routes, registerRoute, registerCrudRoutes, describeRoutes, validateCallApiBody };
