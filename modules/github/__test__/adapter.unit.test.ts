// GitHub adapter against the fake GitHub — the entry surface and what the
// checker projects from it, the walks (notification → subject, repository →
// pull requests / issues, → comments / labels), the WHERE pushdown, and the
// two writes.

import { singleParentLink, type WriteInput } from 'movement-engine/public/adapter';
import {
  ADAPTER_META_TYPE_ID,
  instanceSchemaFromDescriptors,
  makeMetaPosition,
  makeStablePosition,
  positionData,
  type SourcePosition,
} from 'movement-engine/public/catalog';
import type { Expression } from 'engine-contracts/expression/expression';

import { GithubClient, normalizeNotification, normalizePullRequest } from '../api_client';
import { GithubAdapter } from '../adapter';
import { issueQueryFromWhere, pinnedRepository, pullQueryFromWhere } from '../filter';
import {
  GITHUB_ISSUE_DISPLAY_NAME,
  GITHUB_NOTIFICATION_DISPLAY_NAME,
  GITHUB_PULL_REQUEST_DISPLAY_NAME,
  GITHUB_REPOSITORY_DISPLAY_NAME,
} from '../types';
import { startFakeGithub, type FakeGithub } from './fake_github';

const log = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

let fake: FakeGithub;
let adapter: GithubAdapter;

beforeEach(async () => {
  fake = await startFakeGithub({ token: 'ghp_test' });
  fake.repo({ owner: 'acme', name: 'api', description: 'The API' });
  fake.repo({ owner: 'acme', name: 'web' });
  fake.pull('acme/api', { number: 42, title: 'Add retries', reviewers: ['henry'], labels: ['enhancement'], author: 'ada' });
  fake.pull('acme/api', { number: 40, title: 'Old work', state: 'closed', merged: true });
  fake.issue('acme/api', { number: 7, title: 'Crash on boot', labels: ['bug'], assignees: ['henry'], author: 'grace' });
  fake.issue('acme/api', { number: 5, title: 'Closed long ago', state: 'closed' });
  adapter = new GithubAdapter(async () => new GithubClient({ token: 'ghp_test', baseUrl: fake.url, fetch, log }));
});

afterEach(async () => {
  await fake.close();
});

const meta = (): SourcePosition => makeMetaPosition('github');

async function walk(from: SourcePosition, edge: string, extra: { where?: Expression; limit?: number; orderBy?: { fieldId: string; direction: 'asc' | 'desc' } } = {}) {
  return adapter.getRelated({ position: from, fieldId: edge, direction: 'outgoing', ...extra });
}

async function read(position: SourcePosition, field: string): Promise<unknown> {
  return adapter.getFieldValue({ position, fieldId: field });
}

const eq = (field: string, value: string): Expression => ({ type: 'compare', op: 'eq', left: { type: 'edge_property', propertyTypeId: field }, right: { type: 'static', value } }) as Expression;
const memberOf = (value: string, field: string): Expression => ({ type: 'compare', op: 'in', left: { type: 'static', value }, right: { type: 'edge_property', propertyTypeId: field } }) as Expression;
const and = (...operands: Expression[]): Expression => ({ type: 'logical', op: 'and', operands }) as Expression;

async function repoApi(): Promise<SourcePosition> {
  const [repo] = await walk(meta(), 'Repositories', { where: eq('Full Name', 'acme/api') });
  if (repo === undefined) throw new Error('no repo');
  return repo.position;
}

describe('GithubAdapter surface', () => {
  it('projects to a checker schema with every type, the root collections and the notification event', async () => {
    const entries = await adapter.listEntryPoints();
    const descriptors = new Map(
      (await Promise.all(entries.map(async (e) => [e.typeId, await adapter.describe(e.typeId)] as const))).flatMap(([id, d]) => (d ? [[id, d] as const] : [])),
    );
    const metaDescriptor = await adapter.describe(ADAPTER_META_TYPE_ID);
    const { schema, notes } = instanceSchemaFromDescriptors({
      adapterType: 'github',
      entries,
      descriptors,
      ...(metaDescriptor !== null ? { metaDescriptor } : {}),
      supportsInPlaceUpdate: false,
    });
    expect(Object.keys(schema.collections).sort()).toEqual(['Notifications', 'Repositories']);
    expect(Object.keys(schema.positions).sort()).toEqual(expect.arrayContaining(['Comment', 'Issue', 'Label', 'Notification', 'Pull Request', 'Repository']));
    expect(schema.positions['Issue']?.propertyCapabilities?.['Label Names']).toEqual({ filterOperators: ['contains'] });
    expect(notes.filter((n) => n.includes('root descriptor'))).toEqual([]);
  });

  it('types a notification’s reason as GitHub’s closed set, and its subject as two edges', async () => {
    const notification = await adapter.describe(GITHUB_NOTIFICATION_DISPLAY_NAME);
    expect(notification?.fields.find((f) => f.displayName === 'Reason')).toMatchObject({ kind: 'enum', enumValues: expect.arrayContaining(['review_requested', 'mention', 'assign']) });
    expect(notification?.references.map((r) => [r.name, r.targetTypeId, r.cardinality])).toEqual([
      ['Repository', 'github:repository', 'one'],
      ['Pull Request', 'github:pull_request', 'one'],
      ['Issue', 'github:issue', 'one'],
    ]);
  });

  it('makes only Comments and Labels writable, and only Body and Name', async () => {
    const pr = await adapter.describe(GITHUB_PULL_REQUEST_DISPLAY_NAME);
    expect(pr?.references.filter((r) => r.writable === true).map((r) => r.name)).toEqual(['Comments', 'Labels']);
    expect(pr?.fields.filter((f) => f.writable)).toEqual([]);
    expect((await adapter.describe('Comment'))?.fields.filter((f) => f.writable).map((f) => f.displayName)).toEqual(['Body']);
    expect((await adapter.describe('Label'))?.fields.filter((f) => f.writable).map((f) => f.displayName)).toEqual(['Name']);
  });
});

describe('GithubAdapter walks', () => {
  it('follows a review request to its pull request, and on to its comments, labels and repository', async () => {
    fake.notify({ id: 't1', reason: 'review_requested', repo: 'acme/api', type: 'PullRequest', number: 42, title: 'Add retries', updated_at: '2026-10-28T09:02:00Z' });
    const [thread] = (await walk(meta(), 'Notifications')).map((r) => r.position);
    expect(thread?.recordType).toBe(GITHUB_NOTIFICATION_DISPLAY_NAME);
    expect(await read(thread!, 'Reason')).toBe('review_requested');
    expect(await read(thread!, 'Subject Type')).toBe('PullRequest');

    const [pr] = (await walk(thread!, 'Pull Request')).map((r) => r.position);
    expect(await walk(thread!, 'Issue')).toEqual([]);
    expect(pr?.recordType).toBe(GITHUB_PULL_REQUEST_DISPLAY_NAME);
    expect(await read(pr!, 'Title')).toBe('Add retries');
    expect(await read(pr!, 'Number')).toBe(42);
    expect(await read(pr!, 'HTML URL')).toBe('https://github.com/acme/api/pull/42');
    expect(await read(pr!, 'Requested Reviewers')).toEqual(['henry']);
    expect(await read(pr!, 'Author')).toBe('ada');
    expect(await read(pr!, 'Merged')).toBe(false);
    expect(fake.requests.some((r) => r.path === '/repos/acme/api/pulls/42')).toBe(true);

    expect((await walk(pr!, 'Labels')).map((r) => positionData(r.position))).toEqual([expect.objectContaining({ name: 'enhancement', color: 'a2eeef' })]);
    const [repo] = (await walk(pr!, 'Repository')).map((r) => r.position);
    expect(await read(repo!, 'Full Name')).toBe('acme/api');
    expect(await walk(pr!, 'Comments')).toEqual([]);
  });

  it('reads a notification’s repository off the thread, with no call', async () => {
    fake.notify({ id: 't1', reason: 'mention', repo: 'acme/web', type: 'Release', title: 'v2', updated_at: '2026-10-28T09:02:00Z' });
    const [thread] = (await walk(meta(), 'Notifications')).map((r) => r.position);
    const calls = fake.requests.length;
    const [repo] = (await walk(thread!, 'Repository')).map((r) => r.position);
    expect(await read(repo!, 'Name')).toBe('web');
    expect(await walk(thread!, 'Pull Request')).toEqual([]);
    expect(fake.requests).toHaveLength(calls);
  });

  it('lists the token’s repositories, or fetches the one a `Full Name` pins', async () => {
    const all = await walk(meta(), 'Repositories');
    expect(await Promise.all(all.map((r) => read(r.position, 'Full Name')))).toEqual(['acme/api', 'acme/web']);
    const pinned = await repoApi();
    expect(pinned.recordType).toBe(GITHUB_REPOSITORY_DISPLAY_NAME);
    expect(await read(pinned, 'Description')).toBe('The API');
    expect(fake.requests.at(-1)?.path).toBe('/repos/acme/api');
  });

  it('walks a repository’s pull requests open AND closed when the WHERE names no state', async () => {
    const repo = await repoApi();
    const all = await walk(repo, 'Pull Requests');
    expect(await Promise.all(all.map((r) => read(r.position, 'Number')))).toEqual([42, 40]);
    expect(fake.requests.at(-1)?.path).toBe('/repos/acme/api/pulls?state=all&per_page=100&page=1');
    const open = await walk(repo, 'Pull Requests', { where: eq('State', 'open'), limit: 1 });
    expect(open).toHaveLength(1);
    expect(fake.requests.at(-1)?.path).toBe('/repos/acme/api/pulls?state=open&per_page=1&page=1');
  });

  it('walks issues without the pull requests GitHub’s listing mixes in, pushing state, labels and assignee', async () => {
    const repo = await repoApi();
    const all = await walk(repo, 'Issues');
    expect(await Promise.all(all.map((r) => read(r.position, 'Number')))).toEqual([7, 5]);
    const bugs = await walk(repo, 'Issues', { where: and(eq('State', 'open'), memberOf('bug', 'Label Names'), memberOf('henry', 'Assignees')) });
    expect(bugs.map((r) => r.position.recordType)).toEqual([GITHUB_ISSUE_DISPLAY_NAME]);
    expect(await read(bugs[0]!.position, 'Label Names')).toEqual(['bug']);
    expect(fake.requests.at(-1)?.path).toBe('/repos/acme/api/issues?state=open&labels=bug&assignee=henry&per_page=100&page=1');
  });

  it('refuses to follow a subject link outside the credential’s API base', async () => {
    const thread = makeStablePosition({
      adapterType: 'github',
      recordType: GITHUB_NOTIFICATION_DISPLAY_NAME,
      recordId: 't9',
      data: { ...normalizeNotification({
        id: 't9', reason: 'mention', unread: true, updated_at: '2026-10-28T09:00:00Z', last_read_at: null, url: '', subscription_url: '',
        subject: { title: 'x', url: 'https://evil.example/repos/a/b/pulls/1', latest_comment_url: null, type: 'PullRequest' },
        repository: { id: 1, name: 'b', full_name: 'a/b', owner: { login: 'a', id: 1 }, private: false, html_url: '', description: null, fork: false },
      }) },
    });
    await expect(walk(thread, 'Pull Request')).rejects.toThrow(/not under the credential's API base/);
    expect(fake.requests).toEqual([]);
  });
});

describe('GithubAdapter writes', () => {
  /** A write along `edge` of the pull request #42 the walk reached. */
  async function along(edge: string, recordType: string, fields: Record<string, unknown>): Promise<WriteInput> {
    const repo = await repoApi();
    const [pr] = (await walk(repo, 'Pull Requests', { where: eq('State', 'open') })).map((r) => r.position);
    return {
      recordType,
      fields,
      parentLinks: [{ recordType: GITHUB_PULL_REQUEST_DISPLAY_NAME, externalId: pr!.identity.kind === 'stable' ? pr!.identity.recordId : '', edgeName: edge, data: positionData(pr!) as Record<string, unknown> }],
    } as unknown as WriteInput;
  }

  it('comments on a pull request along its Comments edge', async () => {
    const write = await along('Comments', 'Comment', { Body: 'Looking at this today.' });
    expect(singleParentLink(write)?.data).toMatchObject({ owner: 'acme', repo: 'api', number: 42 });
    const written = await adapter.createRecord(write);
    expect(written).toMatchObject({ adapterType: 'github', recordType: 'Comment', url: expect.stringContaining('/acme/api/issues/42#issuecomment-') });
    expect(fake.comments('acme/api', 42).map((c) => c.body)).toEqual(['Looking at this today.']);
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: '/repos/acme/api/issues/42/comments', body: { body: 'Looking at this today.' } });
  });

  it('adds a label along the Labels edge, keeping the ones already there', async () => {
    const written = await adapter.createRecord(await along('Labels', 'Label', { Name: 'triaged' }));
    expect(written).toMatchObject({ recordType: 'Label', data: expect.objectContaining({ name: 'triaged' }) });
    expect(fake.labelsOn('acme/api', 42)).toEqual(['enhancement', 'triaged']);
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: '/repos/acme/api/issues/42/labels', body: { labels: ['triaged'] } });
  });

  it('refuses a comment with no body, and a write with no pull request or issue to hang it off', async () => {
    await expect(adapter.createRecord(await along('Comments', 'Comment', { Body: '  ' }))).rejects.toThrow(/`Body` is required/);
    await expect(adapter.createRecord({ recordType: 'Comment', fields: { Body: 'x' } } as unknown as WriteInput)).rejects.toThrow(/written along one pull request's or issue's edge/);
  });

  it('writes nothing else', async () => {
    await expect(adapter.createRecord({ recordType: 'Pull Request', fields: {} } as unknown as WriteInput)).rejects.toThrow(/cannot be created/);
    await expect(adapter.updateRecord({ recordType: 'Issue', externalId: '1', fields: {} } as never)).rejects.toThrow(/not supported/);
  });
});

describe('the WHERE pushdown', () => {
  it('asks for every state unless the WHERE pins one, and is exact only when everything pushed', () => {
    expect(pullQueryFromWhere(undefined)).toEqual({ state: 'all', exact: true });
    expect(pullQueryFromWhere(eq('State', 'closed'))).toEqual({ state: 'closed', exact: true });
    expect(pullQueryFromWhere(and(eq('State', 'open'), eq('Title', 'x')))).toEqual({ state: 'open', exact: false });
  });

  it('pushes an issue author, labels and an Updated At floor (which is never exact)', () => {
    const floor = { type: 'compare', op: 'gte', left: { type: 'edge_property', propertyTypeId: 'Updated At' }, right: { type: 'static', value: '2026-10-01T00:00:00Z' } } as Expression;
    expect(issueQueryFromWhere(and(eq('Author', 'grace'), memberOf('bug', 'Label Names'), memberOf('p1', 'Label Names'), floor))).toEqual({
      query: { state: 'all', labels: ['bug', 'p1'], creator: 'grace', since: '2026-10-01T00:00:00Z' },
      exact: false,
    });
  });

  it('pushes nothing from under an OR', () => {
    const either = { type: 'logical', op: 'or', operands: [eq('State', 'open'), eq('Author', 'grace')] } as Expression;
    expect(issueQueryFromWhere(either)).toEqual({ query: { state: 'all' }, exact: false });
  });

  it('pins a repository only by a whole owner/name', () => {
    expect(pinnedRepository(eq('Full Name', 'acme/api'))).toEqual({ owner: 'acme', repo: 'api' });
    expect(pinnedRepository(eq('Full Name', 'acme'))).toBeUndefined();
    expect(pinnedRepository(eq('Name', 'acme/api'))).toBeUndefined();
  });
});

describe('normalisation', () => {
  it('reads a merged pull request off merged_at, which the listing carries in place of `merged`', () => {
    const pr = normalizePullRequest(
      {
        id: 1, number: 1, state: 'closed', title: 't', body: null, user: null, labels: [], html_url: 'h',
        created_at: 'c', updated_at: 'u', closed_at: 'x', merged_at: '2026-10-27T10:00:00Z', head: { ref: 'f', sha: 's' }, base: { ref: 'main', sha: 's' },
      },
      { owner: 'o', repo: 'r' },
    );
    expect(pr).toMatchObject({ merged: true, draft: false, author: null, head_ref: 'f', base_ref: 'main', owner: 'o', repo: 'r' });
  });
});
