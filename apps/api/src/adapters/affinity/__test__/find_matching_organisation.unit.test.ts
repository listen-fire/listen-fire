// `findMatchingOrganisation` is the create path's identity search: it decides
// whether an incoming company is one Affinity already holds. It asks by
// DOMAIN first, through Affinity's `term` search — a substring match against
// the domain string Affinity stored.
//
// Affinity stores a bare host (`veltha.ai`). Searching by a URL origin
// (`https://veltha.ai`) is a substring match that can never hit, so every
// lookup for a URL-shaped domain fell through to the name search and, when the
// name had drifted at all, created a duplicate company.

jest.mock('../../../lib/anthropic', () => ({
  anthropicChat: jest.fn(async () => 'null'),
}));

import { findMatchingOrganisation } from '../common';
import type { AffinityAPIClient } from '../apiClient';

const VELTHA = { id: 1, name: 'Veltha', domain: 'veltha.ai', domains: ['veltha.ai'], global: false };

function clientWith(orgs: typeof VELTHA[]) {
  const findManyOrganisations = jest.fn(async ({ search }: { search: string }) => {
    const term = search.toLowerCase();
    return orgs.filter(
      (o) => o.name.toLowerCase().includes(term) || o.domain.toLowerCase().includes(term),
    );
  });
  return { client: { findManyOrganisations } as unknown as AffinityAPIClient, findManyOrganisations };
}

describe('findMatchingOrganisation searches by the domain Affinity actually stores', () => {
  it.each([
    ['a bare domain', 'veltha.ai'],
    ['a full URL', 'https://www.veltha.ai/careers?ref=x'],
    ['a bare host with www', 'www.veltha.ai'],
    ['a domain with stray padding', '  Veltha.ai  '],
  ])('searches by the bare host for %s', async (_label, input) => {
    const { client, findManyOrganisations } = clientWith([VELTHA]);

    const match = await findMatchingOrganisation(client, { name: 'Veltha Labs', domain: input });

    expect(findManyOrganisations).toHaveBeenCalledWith({ search: 'veltha.ai', includeGlobal: true });
    expect(match).toEqual(VELTHA);
  });

  it('still matches when Affinity stored the domain URL-shaped', async () => {
    // The comparison normalizes both sides, so which side carries the scheme
    // stops mattering.
    const stored = { ...VELTHA, domain: 'https://veltha.ai', domains: ['https://veltha.ai'] };
    const { client } = clientWith([stored]);

    expect(
      await findMatchingOrganisation(client, { name: 'Veltha Labs', domain: 'veltha.ai' }),
    ).toEqual(stored);
  });

  it('falls back to the name search when the domain is not one Affinity holds', async () => {
    const { client, findManyOrganisations } = clientWith([VELTHA]);

    const match = await findMatchingOrganisation(client, { name: 'Veltha', domain: 'nowhere.example' });

    expect(match).toEqual(VELTHA);
    expect(findManyOrganisations).toHaveBeenCalledWith({ search: 'nowhere.example', includeGlobal: true });
    expect(findManyOrganisations).toHaveBeenCalledWith({ search: 'Veltha', includeGlobal: false });
  });
});
