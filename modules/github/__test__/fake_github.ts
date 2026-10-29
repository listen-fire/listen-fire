// A fake GitHub REST API for the module's tests and listen-fire's, served on a loopback
// port at the root (as api.github.com is). The shapes are GitHub's own (REST
// API 2022-11-28: notifications, repositories, pulls, issues, issue comments,
// issue labels), and so is the polling contract of `GET /notifications`:
// `Last-Modified` on a 200, a 304 for an `If-Modified-Since` nothing has
// changed since, and `X-Poll-Interval`. Listings page by `per_page`/`page`
// and say a next page in a `Link` header. A wrong token is answered 401.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeGithubRequest {
  method: string;
  /** Path and query, as sent. */
  path: string;
  authorization: string | undefined;
  ifModifiedSince: string | undefined;
  body: unknown;
}

export interface FakeRepo {
  owner: string;
  name: string;
  private?: boolean;
  description?: string;
}

export interface FakePull {
  number: number;
  title: string;
  state?: 'open' | 'closed';
  draft?: boolean;
  merged?: boolean;
  author?: string;
  body?: string;
  labels?: string[];
  reviewers?: string[];
  created_at?: string;
}

export interface FakeIssue {
  number: number;
  title: string;
  state?: 'open' | 'closed';
  author?: string;
  labels?: string[];
  assignees?: string[];
  created_at?: string;
  updated_at?: string;
}

export interface FakeNotification {
  id: string;
  reason: string;
  repo: string;
  /** `PullRequest`, `Issue`, `Release`, … */
  type: string;
  /** The pull request's or issue's number, for those types. */
  number?: number;
  title: string;
  updated_at: string;
  unread?: boolean;
  participating?: boolean;
}

export interface FakeGithub {
  /** The API base a credential names: `http://127.0.0.1:<port>`. */
  url: string;
  requests: FakeGithubRequest[];
  repo(repo: FakeRepo): void;
  pull(repo: string, pull: FakePull): void;
  issue(repo: string, issue: FakeIssue): void;
  notify(notification: FakeNotification): void;
  /** What `X-Poll-Interval` says from now on. */
  pollInterval(seconds: number): void;
  comments(repo: string, number: number): Array<{ id: number; body: string; user: { login: string } }>;
  labelsOn(repo: string, number: number): string[];
  close(): Promise<void>;
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text === '' ? undefined : JSON.parse(text);
}

const USER = (login: string, id = 1): Record<string, unknown> => ({
  login,
  id,
  node_id: `U_${login}`,
  avatar_url: `https://avatars.example/${login}`,
  html_url: `https://github.com/${login}`,
  type: 'User',
  site_admin: false,
});

const LABEL_COLORS: Record<string, string> = { bug: 'd73a4a', enhancement: 'a2eeef' };

export async function startFakeGithub(options: { token: string; pollIntervalSeconds?: number }): Promise<FakeGithub> {
  const requests: FakeGithubRequest[] = [];
  const repos = new Map<string, FakeRepo & { id: number }>();
  const pulls = new Map<string, Array<FakePull>>();
  const issues = new Map<string, Array<FakeIssue>>();
  const comments = new Map<string, Array<{ id: number; body: string; user: { login: string }; created_at: string }>>();
  const labels = new Map<string, string[]>();
  const notifications: FakeNotification[] = [];
  const labelIds = new Map<string, number>();
  let interval = options.pollIntervalSeconds ?? 60;
  let nextId = 1000;
  let base = '';

  const labelObject = (name: string): Record<string, unknown> => {
    if (!labelIds.has(name)) labelIds.set(name, nextId++);
    const id = labelIds.get(name) ?? 0;
    return { id, node_id: `LA_${id}`, url: `${base}/labels/${encodeURIComponent(name)}`, name, description: null, color: LABEL_COLORS[name] ?? 'ededed', default: false };
  };

  const repoObject = (full: string): Record<string, unknown> => {
    const repo = repos.get(full);
    if (repo === undefined) throw new Error(`fake github: no repo ${full}`);
    return {
      id: repo.id,
      node_id: `R_${repo.id}`,
      name: repo.name,
      full_name: full,
      owner: USER(repo.owner),
      private: repo.private ?? false,
      html_url: `https://github.com/${full}`,
      description: repo.description ?? null,
      fork: false,
      url: `${base}/repos/${full}`,
      archived: false,
      default_branch: 'main',
      created_at: '2024-01-01T00:00:00Z',
      updated_at: '2026-10-01T00:00:00Z',
      pushed_at: '2026-10-01T00:00:00Z',
    };
  };

  const key = (full: string, number: number): string => `${full}#${number}`;
  const labelsOf = (full: string, number: number, initial: string[] | undefined): string[] => {
    if (!labels.has(key(full, number))) labels.set(key(full, number), [...(initial ?? [])]);
    return labels.get(key(full, number)) ?? [];
  };

  const pullObject = (full: string, pr: FakePull): Record<string, unknown> => ({
    url: `${base}/repos/${full}/pulls/${pr.number}`,
    id: 500000 + pr.number,
    node_id: `PR_${pr.number}`,
    html_url: `https://github.com/${full}/pull/${pr.number}`,
    issue_url: `${base}/repos/${full}/issues/${pr.number}`,
    number: pr.number,
    state: pr.state ?? 'open',
    locked: false,
    title: pr.title,
    user: USER(pr.author ?? 'octocat'),
    body: pr.body ?? null,
    labels: labelsOf(full, pr.number, pr.labels).map(labelObject),
    milestone: null,
    created_at: pr.created_at ?? '2026-10-27T09:00:00Z',
    updated_at: pr.created_at ?? '2026-10-27T09:00:00Z',
    closed_at: pr.state === 'closed' ? '2026-10-27T10:00:00Z' : null,
    merged_at: pr.merged === true ? '2026-10-27T10:00:00Z' : null,
    assignees: [],
    requested_reviewers: (pr.reviewers ?? []).map((login, i) => USER(login, 10 + i)),
    requested_teams: [],
    head: { label: `${full.split('/')[0]}:feature-${pr.number}`, ref: `feature-${pr.number}`, sha: 'abc123', user: USER('octocat'), repo: null },
    base: { label: `${full.split('/')[0]}:main`, ref: 'main', sha: 'def456', user: USER('octocat'), repo: null },
    author_association: 'MEMBER',
    auto_merge: null,
    draft: pr.draft ?? false,
  });

  const issueObject = (full: string, issue: FakeIssue): Record<string, unknown> => ({
    id: 700000 + issue.number,
    node_id: `I_${issue.number}`,
    url: `${base}/repos/${full}/issues/${issue.number}`,
    repository_url: `${base}/repos/${full}`,
    html_url: `https://github.com/${full}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state ?? 'open',
    state_reason: issue.state === 'closed' ? 'completed' : null,
    title: issue.title,
    body: null,
    user: USER(issue.author ?? 'octocat'),
    labels: labelsOf(full, issue.number, issue.labels).map(labelObject),
    assignees: (issue.assignees ?? []).map((login, i) => USER(login, 20 + i)),
    milestone: null,
    locked: false,
    comments: (comments.get(key(full, issue.number)) ?? []).length,
    created_at: issue.created_at ?? '2026-10-20T09:00:00Z',
    updated_at: issue.updated_at ?? issue.created_at ?? '2026-10-20T09:00:00Z',
    closed_at: issue.state === 'closed' ? '2026-10-21T09:00:00Z' : null,
    author_association: 'MEMBER',
  });

  const threadObject = (n: FakeNotification): Record<string, unknown> => {
    const kind = n.type === 'PullRequest' ? 'pulls' : n.type === 'Issue' ? 'issues' : undefined;
    const subjectUrl = kind !== undefined && n.number !== undefined ? `${base}/repos/${n.repo}/${kind}/${n.number}` : null;
    return {
      id: n.id,
      repository: repoObject(n.repo),
      subject: { title: n.title, url: subjectUrl, latest_comment_url: subjectUrl, type: n.type },
      reason: n.reason,
      unread: n.unread ?? true,
      updated_at: n.updated_at,
      last_read_at: null,
      url: `${base}/notifications/threads/${n.id}`,
      subscription_url: `${base}/notifications/threads/${n.id}/subscription`,
    };
  };

  /** One page of `rows` per `per_page`/`page`, with GitHub's `Link` header. */
  const page = <T>(res: ServerResponse, url: URL, rows: T[], max: number, headers: Record<string, string> = {}): void => {
    const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 30) || 30, max);
    const pageNo = Number(url.searchParams.get('page') ?? 1) || 1;
    const slice = rows.slice((pageNo - 1) * perPage, pageNo * perPage);
    const link: Record<string, string> = {};
    if (pageNo * perPage < rows.length) {
      const next = new URL(url);
      next.searchParams.set('page', String(pageNo + 1));
      link.Link = `<${base}${next.pathname}${next.search}>; rel="next"`;
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...headers, ...link });
    res.end(JSON.stringify(slice));
  };

  const server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    const url = new URL(req.url ?? '/', 'http://fake');
    requests.push({
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      authorization: req.headers.authorization,
      ifModifiedSince: typeof req.headers['if-modified-since'] === 'string' ? req.headers['if-modified-since'] : undefined,
      body,
    });
    const send = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
      res.end(JSON.stringify(payload));
    };
    if (req.headers.authorization !== `Bearer ${options.token}`) {
      return send(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest', status: '401' });
    }
    const notFound = (): void => send(404, { message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' });
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/notifications') {
      const since = url.searchParams.get('since');
      const before = url.searchParams.get('before');
      const participating = url.searchParams.get('participating') === 'true';
      const all = url.searchParams.get('all') === 'true';
      const newest = notifications.map((n) => Date.parse(n.updated_at)).reduce((a, b) => Math.max(a, b), Date.UTC(2026, 0, 1));
      const lastModified = new Date(Math.floor(newest / 1000) * 1000).toUTCString();
      const pollHeaders = { 'X-Poll-Interval': String(interval) };
      const asked = req.headers['if-modified-since'];
      if (typeof asked === 'string' && Math.floor(newest / 1000) * 1000 <= Date.parse(asked)) {
        res.writeHead(304, { ...pollHeaders, 'Last-Modified': lastModified });
        return res.end();
      }
      const rows = notifications
        .filter((n) => all || (n.unread ?? true))
        .filter((n) => !participating || n.participating === true)
        .filter((n) => since === null || Date.parse(n.updated_at) >= Date.parse(since))
        .filter((n) => before === null || Date.parse(n.updated_at) < Date.parse(before))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .map(threadObject);
      return page(res, url, rows, 50, { ...pollHeaders, 'Last-Modified': lastModified });
    }
    if (req.method === 'GET' && url.pathname === '/user/repos') {
      const rows = [...repos.keys()].sort().map(repoObject);
      return page(res, url, rows, 100);
    }
    if (parts[0] !== 'repos' || parts.length < 3) return notFound();
    const full = `${parts[1]}/${parts[2]}`;
    if (!repos.has(full)) return notFound();
    const rest = parts.slice(3);

    if (req.method === 'GET' && rest.length === 0) return send(200, repoObject(full));
    if (req.method === 'GET' && rest[0] === 'pulls' && rest.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      const rows = (pulls.get(full) ?? [])
        .filter((pr) => state === 'all' || (pr.state ?? 'open') === state)
        .sort((a, b) => b.number - a.number)
        .map((pr) => pullObject(full, pr));
      return page(res, url, rows, 100);
    }
    if (req.method === 'GET' && rest[0] === 'pulls' && rest.length === 2) {
      const pr = (pulls.get(full) ?? []).find((p) => p.number === Number(rest[1]));
      return pr === undefined ? notFound() : send(200, pullObject(full, pr));
    }
    if (req.method === 'GET' && rest[0] === 'issues' && rest.length === 1) {
      const state = url.searchParams.get('state') ?? 'open';
      const wanted = (url.searchParams.get('labels') ?? '').split(',').filter(Boolean);
      const assignee = url.searchParams.get('assignee');
      const creator = url.searchParams.get('creator');
      const since = url.searchParams.get('since');
      // GitHub's issues listing returns the repository's pull requests too.
      const asIssues = (pulls.get(full) ?? []).map((pr): Record<string, unknown> => ({
        ...issueObject(full, { number: pr.number, title: pr.title, state: pr.state ?? 'open', author: pr.author ?? 'octocat', labels: pr.labels, created_at: pr.created_at ?? '2026-10-27T09:00:00Z' }),
        pull_request: { url: `${base}/repos/${full}/pulls/${pr.number}`, html_url: `https://github.com/${full}/pull/${pr.number}`, merged_at: null },
      }));
      const rows: Array<Record<string, unknown>> = [...(issues.get(full) ?? []).map((i) => issueObject(full, i)), ...asIssues]
        .filter((i) => state === 'all' || i.state === state)
        .filter((i) => wanted.every((w) => (i.labels as Array<{ name: string }>).some((l) => l.name === w)))
        .filter((i) => assignee === null || (i.assignees as Array<{ login: string }>).some((a) => a.login === assignee))
        .filter((i) => creator === null || (i.user as { login: string }).login === creator)
        .filter((i) => since === null || Date.parse(String(i.updated_at)) >= Date.parse(since))
        .sort((a, b) => Number(b.number) - Number(a.number));
      return page(res, url, rows, 100);
    }
    if (rest[0] === 'issues' && rest.length >= 2) {
      const number = Number(rest[1]);
      const pr = (pulls.get(full) ?? []).find((p) => p.number === number);
      const issue = (issues.get(full) ?? []).find((i) => i.number === number);
      if (pr === undefined && issue === undefined) return notFound();
      if (req.method === 'GET' && rest.length === 2) {
        return issue !== undefined ? send(200, issueObject(full, issue)) : notFound();
      }
      if (rest[2] === 'comments') {
        const thread = comments.get(key(full, number)) ?? [];
        comments.set(key(full, number), thread);
        if (req.method === 'POST') {
          const text = (body as { body?: unknown } | undefined)?.body;
          if (typeof text !== 'string' || text === '') return send(422, { message: 'Validation Failed', errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }] });
          const comment = { id: nextId++, body: text, user: { login: 'lf-bot' }, created_at: new Date().toISOString() };
          thread.push(comment);
          return send(201, commentObject(full, number, comment));
        }
        const since = url.searchParams.get('since');
        return page(res, url, thread.filter((c) => since === null || c.created_at >= since).map((c) => commentObject(full, number, c)), 100);
      }
      if (rest[2] === 'labels' && req.method === 'POST') {
        const names = (body as { labels?: unknown } | undefined)?.labels;
        if (!Array.isArray(names)) return send(422, { message: 'Invalid request.' });
        const carried = labelsOf(full, number, pr?.labels ?? issue?.labels);
        for (const name of names.map(String)) if (!carried.includes(name)) carried.push(name);
        return send(200, carried.map(labelObject));
      }
    }
    return notFound();
  });

  const commentObject = (full: string, number: number, c: { id: number; body: string; user: { login: string }; created_at: string }): Record<string, unknown> => ({
    id: c.id,
    node_id: `IC_${c.id}`,
    url: `${base}/repos/${full}/issues/comments/${c.id}`,
    html_url: `https://github.com/${full}/issues/${number}#issuecomment-${c.id}`,
    body: c.body,
    user: USER(c.user.login),
    created_at: c.created_at,
    updated_at: c.created_at,
    issue_url: `${base}/repos/${full}/issues/${number}`,
    author_association: 'NONE',
  });

  await new Promise<void>((listening) => server.listen(0, '127.0.0.1', listening));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: base,
    requests,
    repo: (repo) => void repos.set(`${repo.owner}/${repo.name}`, { ...repo, id: nextId++ }),
    pull: (repo, pull) => void pulls.set(repo, [...(pulls.get(repo) ?? []), pull]),
    issue: (repo, issue) => void issues.set(repo, [...(issues.get(repo) ?? []), issue]),
    notify: (notification) => {
      const at = notifications.findIndex((n) => n.id === notification.id);
      if (at >= 0) notifications.splice(at, 1);
      notifications.push(notification);
    },
    pollInterval: (seconds) => void (interval = seconds),
    comments: (repo, number) => (comments.get(key(repo, number)) ?? []).map(({ id, body, user }) => ({ id, body, user })),
    labelsOn: (repo, number) => [...(labels.get(key(repo, number)) ?? [])],
    close: () => new Promise<void>((closed) => server.close(() => closed())),
  };
}
