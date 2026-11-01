// The Slack Web API client: `@slack/web-api`'s WebClient pointed at the
// install's base URL (Slack, or the dev loop's fake), with a short cache on
// the reads a busy workspace repeats (the user and channel lookups every
// inbound message makes). One client per token and base URL per process.
//
// A delivery's lookups (a channel's name, the app's bot user) go through a
// second, bounded client: Slack wants an answer to a delivery within three
// seconds, so a lookup that cannot answer quickly gives up rather than holding
// the delivery for the default client's half hour of retries. The delivery is
// still taken: the field the lookup would have read is named unknown on the
// arrival, and a listen whose filter reads it is reported undecided.
//
// The platform's installer and its v3 output agent use the same client
// (lf-platform's apps/api adapters/slack/webApi re-exports it).

import { z } from 'zod';
import { LogLevel, WebAPICallResult, WebClient } from '@slack/web-api';

const MINUTE = 60_000;

const slackCredsParser = z.object({
  accessToken: z.string(),
  teamId: z.string().optional(),
  enterpriseId: z.string().optional(),
  baseUrl: z.string().url().optional(),
});

/** How a delivery's lookups are bounded: the operator's to set, read from
 *  the module's environment when its client is made. A value that is not a
 *  number in range is the default. */
export interface SlackLookupSettings {
  /** `SLACK_LOOKUP_TIMEOUT_MS`: how long one call may take (2000). */
  timeoutMs: number;
  /** `SLACK_LOOKUP_RETRIES`: calls retried after a failure (0). A call Slack
   *  rate-limits is never retried. */
  retries: number;
  /** `SLACK_LOOKUP_FAILURE_CACHE_MS`: how long a failed lookup answers its
   *  failure before Slack is asked again (5000), so an outage is not asked
   *  once per delivery. */
  failureCacheMs: number;
}

export function slackLookupSettings(env: Readonly<Record<string, string | undefined>> = process.env): SlackLookupSettings {
  const setting = (name: string, fallback: number, least: number) => {
    const raw = env[name];
    const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
    return Number.isInteger(parsed) && parsed >= least ? parsed : fallback;
  };
  return {
    timeoutMs: setting('SLACK_LOOKUP_TIMEOUT_MS', 2000, 1),
    retries: setting('SLACK_LOOKUP_RETRIES', 0, 0),
    failureCacheMs: setting('SLACK_LOOKUP_FAILURE_CACHE_MS', 5000, 0),
  };
}

class WebClientWithCache extends WebClient {
  // A call's answer, settled or in flight: callers asking while one is in
  // flight share it.
  private cache: Record<string, Promise<WebAPICallResult>> = {};
  private readonly failureTtl: number;
  private ttlMap: Record<string, number> = {
    'users.list': 1 * MINUTE,
    'conversations.info': 1 * MINUTE,
    'conversations.members': 1 * MINUTE,
    // Sender-email resolution (`users.info`) runs on every inbound message the
    // shared movements bot processes; profiles/emails are stable, so a 5-minute
    // cache collapses repeated lookups of the same user to one call per window.
    'users.info': 5 * MINUTE,
    // The app's bot user, whom a message `Mentions App` names: read for
    // every inbound message, fixed for the life of the token.
    'auth.test': 60 * MINUTE,
  };

  constructor(token: string, options: ConstructorParameters<typeof WebClient>[1] & { failureTtl?: number }) {
    const { failureTtl = 0, ...client } = options ?? {};
    super(token, client);
    this.failureTtl = failureTtl;
  }

  async apiCall(...args: Parameters<WebClient['apiCall']>): Promise<WebAPICallResult> {
    const [method] = args;
    const ttl = this.ttlMap[method];
    if (!ttl) return super.apiCall(...args);
    const key = JSON.stringify(args);
    const cached = this.cache[key];
    if (cached !== undefined) return cached;

    const answer = super.apiCall(...args);
    this.cache[key] = answer;
    // Unref'd: an eviction timer must not keep a host process alive.
    const evictAfter = (ms: number) => {
      setTimeout(() => {
        if (this.cache[key] === answer) delete this.cache[key];
      }, ms).unref();
    };
    answer.then(
      () => evictAfter(ttl),
      () => evictAfter(this.failureTtl),
    );
    return answer;
  }
}

class SlackAPIClient {
  api: WebClient;
  /** For a delivery's lookups: bounded by the operator's settings, and a
   *  rate-limited call fails at once. */
  lookups: WebClient;

  constructor({ token, baseUrl, lookup = slackLookupSettings() }: { token: string; baseUrl?: string; lookup?: SlackLookupSettings }) {
    this.api = new WebClientWithCache(token, { slackApiUrl: baseUrl });
    this.lookups = new WebClientWithCache(token, {
      slackApiUrl: baseUrl,
      timeout: lookup.timeoutMs,
      retryConfig: { retries: lookup.retries },
      rejectRateLimitedCalls: true,
      // A failed lookup is the module's to say, on the host's log.
      logLevel: LogLevel.ERROR,
      failureTtl: lookup.failureCacheMs,
    });
  }

  async fetch(url: string | URL, init?: RequestInit) {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.api.token}`,
        ...init?.headers,
      },
    });

    return response;
  }
}

const webClientsByAccessToken: Record<string, SlackAPIClient> = {};

const getSlackClient = (token: string, baseUrl?: string): SlackAPIClient => {
  const cacheKey = baseUrl ? `${token}:${baseUrl}` : token;
  if (!webClientsByAccessToken[cacheKey]) {
    webClientsByAccessToken[cacheKey] = new SlackAPIClient({ token, baseUrl });
  }

  return webClientsByAccessToken[cacheKey];
};

export { SlackAPIClient, getSlackClient, slackCredsParser };
