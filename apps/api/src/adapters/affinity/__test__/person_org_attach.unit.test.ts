// `write org-[:People]-> { … }` against a person who already exists with
// exactly the names the write carries. The engine suppresses every field, so
// the adapter is called with an EMPTY field set and the parent org — and the
// association is the whole point of the call: matching is not associating
// (prod run 3285f127, where the run said "update, committed" and no person
// ever joined an organization).
//
// What this pins is that the pinned-id path does the association and NOTHING
// else: no PUT of the person's own unchanged fields, and no PUT at all once
// the person already belongs to the org (so a re-run is free).

import { AffinityOperations } from '../operations';
import { createNoopTracer } from '../../../services/translation_graph/adapters/affinity/shared';
import type { AffinityAPIClient } from '../apiClient';

const PERSON_ID = 77;
const ORG_ID = 501;

function operationsWith(organizationIds: number[]) {
  const getPersonById = jest.fn(async (id: number) => ({
    id,
    first_name: 'Ada',
    last_name: 'Lovelace',
    primary_email: null,
    emails: [],
    organization_ids: organizationIds,
  }));
  const updatePerson = jest.fn(async (id: number, payload: Record<string, unknown>) => ({
    id,
    ...payload,
  }));
  const findManyPeople = jest.fn(async () => {
    throw new Error('a pinned update must never search by name');
  });

  const client = { getPersonById, updatePerson, findManyPeople } as unknown as AffinityAPIClient;
  return { operations: new AffinityOperations(client), getPersonById, updatePerson };
}

/** The shape the adapter's update path hands over for a parent-only attach:
 *  a pinned id, the org, and no field values of any kind. */
const attachOnly = {
  searchQuery: { name: 'Ada Lovelace' },
  userText: '',
  tracer: createNoopTracer(),
  fieldConfigurations: [],
  orgId: ORG_ID,
  affinityId: PERSON_ID,
};

describe('createOrUpdatePerson — a pinned person with no field changes joins the parent org', () => {
  it('adds the org to organization_ids, and writes nothing else', async () => {
    const { operations, updatePerson, getPersonById } = operationsWith([42]);

    const result = await operations.createOrUpdatePerson(attachOnly);

    expect(result).toEqual({ id: PERSON_ID, isNew: false });
    // Exactly one write, and it extends the membership list rather than
    // replacing the person's own fields.
    expect(updatePerson.mock.calls).toEqual([[PERSON_ID, { organization_ids: [42, ORG_ID] }]]);
    // Reads only against the pinned person — never a name search.
    expect(getPersonById.mock.calls.every(([id]) => id === PERSON_ID)).toBe(true);
  });

  it('sends no write at all when the person already belongs to the org', async () => {
    const { operations, updatePerson } = operationsWith([42, ORG_ID]);

    const result = await operations.createOrUpdatePerson(attachOnly);

    expect(result).toEqual({ id: PERSON_ID, isNew: false });
    expect(updatePerson).not.toHaveBeenCalled();
  });

  it('touches nothing when the write names no parent org', async () => {
    const { operations, updatePerson } = operationsWith([42]);

    const result = await operations.createOrUpdatePerson({ ...attachOnly, orgId: undefined });

    expect(result).toEqual({ id: PERSON_ID, isNew: false });
    expect(updatePerson).not.toHaveBeenCalled();
  });
});
