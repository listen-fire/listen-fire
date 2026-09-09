/** How long the caller is willing to wait for the profile service to finish
 *  collecting. The service collects asynchronously and is polled, so waiting
 *  is the whole cost: a deliberate lookup of one person can afford minutes,
 *  while a fan-out fetching a link off every record cannot. Omitted means the
 *  adapter's own patience, which is minutes. */
interface ProfileFetchBudget {
  maxWaitMs?: number;
}

interface LinkedinAdapter {
  getProfileTextByUrl(
    url: string,
    budget?: ProfileFetchBudget,
  ): Promise<{ text?: string | null; avatar?: string | null } | null>;
}

export { LinkedinAdapter, ProfileFetchBudget };
