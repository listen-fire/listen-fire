// The host's records door, reached by a module served as a process: facts
// about the host's runs and waits (docs/contracts/system-events.md, "The
// records door"), one POST per read. The door names its methods and its
// rows; the module that reads them checks what it reads.

import type { ModuleRecords } from './define';

export interface HostRecordsDoor {
  /** `{host}/api/public/adapter/{module}/records`. */
  url: string;
  /** The headers the host's doors take from this process. */
  headers: Readonly<Record<string, string>>;
}

/** What a refused read says: the door's own message where it gave one. */
function refusal(status: number, body: string): string {
  try {
    const message: unknown = Reflect.get(Object(JSON.parse(body)), 'message');
    if (typeof message === 'string') return message;
  } catch {
    // Not JSON: the body as it came.
  }
  return `the host's records door answered ${status}: ${body}`;
}

export function hostRecords(door: HostRecordsDoor): ModuleRecords {
  return {
    async read(method, params = {}) {
      const response = await fetch(door.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...door.headers },
        body: JSON.stringify({ method, params }),
      });
      if (!response.ok) throw new Error(refusal(response.status, await response.text()));
      const answer: unknown = await response.json();
      return Reflect.get(Object(answer), 'result');
    },
  };
}

/** A host that keeps no records a module may read: every read refuses, saying why. */
export function refusingRecords(reason: string): ModuleRecords {
  return {
    read: async () => {
      throw new Error(reason);
    },
  };
}
