import { getEnvVar } from './utils/environment';

/**
 * This deployment's OWN public base URL, without a trailing slash.
 *
 * Everything that has to name us to the outside world reads it: the webhook
 * callback URLs we register with third parties, OAuth redirects, links back
 * into the app, and the self-referential REST clients (valuations, knowledge).
 *
 * It is deliberately LOUD when unset in production. The webhook-sync URL
 * builder used to fall back to `https://example.com`, so a deployment that
 * forgot the var registered its subscriptions AT LISTEN-FIRE — successfully and
 * silently, with the events going somewhere else entirely. A dev default is
 * fine (nothing outside the machine is being told where to call back); a
 * production default is a data-leak with a friendly face.
 */
function apiBaseUrl(): string {
  return getEnvVar('API_BASE_URL', {
    devDefault: 'http://localhost:3000',
    because:
      "it is this deployment's own public base URL — webhook callbacks, OAuth " +
      'redirects and links back into the app are built from it, and there is no ' +
      'safe default for someone else to guess',
  }).replace(/\/$/, '');
}

export { apiBaseUrl };
