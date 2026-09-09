// Fake-channels redirection for the test-harness team: a credential belonging
// to that team keeps its real shape but points at the local fake service, so an
// adapter exercises its real request path without reaching a third party.

const testHarnessConfig = {
  teamId: process.env.TEST_HARNESS_TEAM_ID || (null as string | null),
};

function getTestHarnessConfig() {
  return { ...testHarnessConfig };
}

const FAKE_CHANNELS_URL = process.env.FAKE_CHANNELS_URL || 'http://localhost:5556';

const fakeBaseUrlByService: Record<string, string> = {
  AFFINITY: `${FAKE_CHANNELS_URL}/affinity`,
  ATTIO: `${FAKE_CHANNELS_URL}/attio`,
  SLACK: `${FAKE_CHANNELS_URL}/slack`,
  TELEGRAM: `${FAKE_CHANNELS_URL}/telegram`,
  GOOGLE_SHEETS: `${FAKE_CHANNELS_URL}/sheets`,
  // googleapis resolves request paths against the rootUrl ORIGIN (any path
  // prefix is dropped), so the fake serves /drive/v3/* from its root.
  GOOGLE_DRIVE: FAKE_CHANNELS_URL,
  DROPBOX: `${FAKE_CHANNELS_URL}/dropbox`,
  AIRTABLE: `${FAKE_CHANNELS_URL}/airtable`,
  GRANOLA: `${FAKE_CHANNELS_URL}/granola`,
  EVERTRACE: `${FAKE_CHANNELS_URL}/evertrace`,
  WEBHOOK: `${FAKE_CHANNELS_URL}/webhook`,
};

function isTestHarnessTeam(teamId: string): boolean {
  return !!testHarnessConfig.teamId && teamId === testHarnessConfig.teamId;
}

function injectFakeBaseUrl(creds: Record<string, unknown>, serviceType: string): Record<string, unknown> {
  const fakeUrl = fakeBaseUrlByService[serviceType];
  if (!fakeUrl) return creds;
  return { ...creds, baseUrl: fakeUrl };
}

export { testHarnessConfig, getTestHarnessConfig, isTestHarnessTeam, injectFakeBaseUrl };
