// The host's plugins door, reached by a module served as a process: a pure
// plugin's answers the host keeps (adapter protocol 2.10), forgotten when
// the module says they changed. One POST per invalidation.

import type { ModulePluginAnswers } from './define';

export interface HostPluginsDoor {
  /** `{host}/api/public/adapter/{module}/plugins`. */
  url: string;
  /** The headers the host's doors take from this process. */
  headers: Readonly<Record<string, string>>;
}

/** What a refused invalidation says: the door's own message where it gave one. */
function refusal(status: number, body: string): string {
  try {
    const message: unknown = Reflect.get(Object(JSON.parse(body)), 'message');
    if (typeof message === 'string') return message;
  } catch {
    // Not JSON: the body as it came.
  }
  return `the host's plugins door answered ${status}: ${body}`;
}

export function hostPluginAnswers(door: HostPluginsDoor): ModulePluginAnswers {
  return {
    async invalidatePluginAnswers({ plugin, args }) {
      const response = await fetch(door.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...door.headers },
        body: JSON.stringify({ method: 'plugins.invalidate', params: { plugin, ...(args !== undefined ? { args } : {}) } }),
      });
      // A host before 2.10 serves no plugins door: it keeps no answers, so it has none to forget.
      if (response.status === 404) return;
      if (!response.ok) throw new Error(refusal(response.status, await response.text()));
    },
  };
}

/** A host that keeps no plugin's answers: an invalidation has nothing to forget. */
export const keepingNoAnswers: ModulePluginAnswers = {
  invalidatePluginAnswers: async () => undefined,
};
