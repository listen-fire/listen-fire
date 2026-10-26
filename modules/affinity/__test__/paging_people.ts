// The person matcher over a real client, with models that never match on a
// name — so whatever it finds, it found by email.

import type { AffinityAPIClient } from '../api_client';

import { AffinityOperations } from '../operations';

export function findMatchingPersonWith(client: AffinityAPIClient, query: { name: string; email: string }) {
  const models = {
    chat: async () => JSON.stringify({ name: null }),
    chatStructured: async <T,>(input: { schema: { parse(value: unknown): T } }): Promise<T> => input.schema.parse({ id: null }),
  };
  return new AffinityOperations(client, models).findMatchingPerson(query);
}
