// GitHub REST client + wire shapes — shared by the read/write adapter
// (adapter.ts, write.ts) and the poll (poll.ts). The shapes are GitHub's own
// (REST API version 2022-11-28), trimmed to the keys this module reads. It
// reaches GitHub through the fetch and the log its host hands the module,
// never the process's own.

import { z } from 'zod';

import { networkErrorCode, retryingFetch, type AttemptFailure, type ModuleLog, type RetryFetchOptions } from 'module-kit';

import type {
  GithubCommentPayload,
  GithubIssuePayload,
  GithubLabelPayload,
  GithubNotificationPayload,
  GithubPullRequestPayload,
  GithubRepoRef,
  GithubRepositoryPayload,
} from './types';

export const GITHUB_DEFAULT_BASE_URL = 'https://api.github.com';
/** The REST API version every request pins. */
export const GITHUB_API_VERSION = '2022-11-28';

/** Stored GitHub credential — a personal access token, fine-grained or
 *  classic. `baseUrl` points it at GitHub Enterprise Server
 *  (`https://ghe.example.com/api/v3`) or at the dev loop's fake. */
export const githubCredsParser = z.object({
  token: z.string().min(1),
  baseUrl: z.string().url().optional(),
});
export type GithubCredentials = z.infer<typeof githubCredsParser>;

// ── GitHub API shapes ───────────────────────────────────────────────────────

export interface GithubSimpleUser {
  login: string;
  id: number;
}

export interface GithubLabel {
  id: number;
  name: string;
  color: string | null;
  description: string | null;
}

export interface GithubRepository {
  id: number;
  name: string;
  full_name: string;
  owner: GithubSimpleUser;
  private: boolean;
  html_url: string;
  description: string | null;
  fork: boolean;
  /** Absent on the minimal repository a notification carries. */
  archived?: boolean;
  default_branch?: string;
  created_at?: string | null;
  updated_at?: string | null;
  pushed_at?: string | null;
}

export interface GithubThread {
  id: string;
  repository: GithubRepository;
  subject: { title: string; url: string | null; latest_comment_url: string | null; type: string };
  reason: string;
  unread: boolean;
  updated_at: string;
  last_read_at: string | null;
  url: string;
  subscription_url: string;
}

export interface GithubPullRequest {
  id: number;
  number: number;
  state: string;
  title: string;
  body: string | null;
  user: GithubSimpleUser | null;
  labels: GithubLabel[];
  assignees?: GithubSimpleUser[] | null;
  requested_reviewers?: GithubSimpleUser[] | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  merged_at: string | null;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export interface GithubIssue {
  id: number;
  number: number;
  state: string;
  state_reason?: string | null;
  title: string;
  body?: string | null;
  user: GithubSimpleUser | null;
  labels: Array<GithubLabel | string>;
  assignees?: GithubSimpleUser[] | null;
  comments: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  /** Present when the issue is a pull request (the issues listing returns both). */
  pull_request?: unknown;
}

export interface GithubIssueComment {
  id: number;
  body?: string;
  user: GithubSimpleUser | null;
  author_association?: string;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export class GithubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: string,
  ) {
    super(message);
    this.name = 'GithubApiError';
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

/** The query a repository's issues listing takes (`GET /repos/{o}/{r}/issues`). */
export interface GithubIssueQuery {
  state: 'open' | 'closed' | 'all';
  labels?: string[];
  assignee?: string;
  creator?: string;
  since?: string;
}

/** What the notifications listing answered: a 304 when nothing changed since
 *  `ifModifiedSince`, else the threads. Both carry the poll interval GitHub
 *  asks for. */
export type GithubNotificationsAnswer =
  | { modified: false; pollIntervalSeconds?: number }
  | { modified: true; threads: GithubThread[]; lastModified?: string; date?: string; pollIntervalSeconds?: number };

export interface GithubClientOptions {
  token: string;
  baseUrl?: string;
  /** The host's fetch. */
  fetch: typeof fetch;
  log: ModuleLog;
  /** Retry policy overrides (tests shorten the waits). */
  retry?: RetryFetchOptions;
}

/** Most rows GitHub hands back per page on every listing used here, but the
 *  notifications one (50). */
const PAGE_SIZE = 100;
const NOTIFICATIONS_PAGE_SIZE = 50;

/** A request that changes something is sent again only where it cannot have
 *  reached GitHub: a 429, or a connection that was never made. */
function mayResend(failure: AttemptFailure, init: RequestInit | undefined): boolean {
  if ((init?.method ?? 'GET') === 'GET') return true;
  if (failure.kind === 'status') return failure.status === 429;
  const code = networkErrorCode(failure.error);
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND';
}

/** Whether GitHub's `Link` header names a next page. */
function hasNextPage(res: Response): boolean {
  return /<[^>]*>;\s*rel="next"/.test(res.headers.get('link') ?? '');
}

function pollInterval(res: Response): number | undefined {
  const header = res.headers.get('x-poll-interval');
  const value = Number(header);
  return header !== null && header !== '' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export class GithubClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: ModuleLog;

  constructor(options: GithubClientOptions) {
    this.base = (options.baseUrl ?? GITHUB_DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = retryingFetch(options.fetch, {
      ...options.retry,
      mayRetry: mayResend,
      onRetry: (note) => options.log.warn(`[github] ${note.because}; retry ${note.attempt}/${note.of} in ${note.waitMs}ms`),
    });
    this.log = options.log;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      'User-Agent': 'listen-fire',
      ...extra,
    };
  }

  /** One request, refused by status with what the author can do about it. */
  private async send(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Response> {
    const res = await this.fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: this.headers({ ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...init.headers }),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (res.ok || res.status === 304) return res;
    const body = await res.text().catch(() => '');
    throw new GithubApiError(res.status, this.refusal(res, body, url), body);
  }

  private refusal(res: Response, body: string, url: string): string {
    const said = (() => {
      try {
        const message = (JSON.parse(body) as { message?: unknown }).message;
        return typeof message === 'string' ? message : body.slice(0, 200);
      } catch {
        return body.slice(0, 200);
      }
    })();
    if (res.status === 401) {
      return `GitHub refused the token (401): check the token of the @lf/github credential. ${said}`.trim();
    }
    if ((res.status === 403 || res.status === 429) && res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const when = Number.isFinite(reset) && reset > 0 ? ` until ${new Date(reset * 1000).toISOString()}` : '';
      return `GitHub's rate limit for this token is spent${when} (${res.status}).`;
    }
    if (res.status === 404) {
      return `GitHub answered 404 for ${new URL(url).pathname}: it does not exist, or the token cannot see it (a fine-grained token names the repositories it reaches). ${said}`.trim();
    }
    return `GitHub API ${res.status}: ${said}`;
  }

  private async json<T>(path: string): Promise<T> {
    return (await (await this.send(`${this.base}${path}`)).json()) as T;
  }

  /** Every page of a listing, or the first `limit` rows. GitHub's `Link`
   *  header says whether another page follows. */
  private async pages<T>(path: string, params: URLSearchParams, limit?: number): Promise<T[]> {
    const rows: T[] = [];
    for (let page = 1; ; page++) {
      const size = limit !== undefined ? Math.min(PAGE_SIZE, Math.max(limit - rows.length, 0)) : PAGE_SIZE;
      if (size === 0) break;
      const query = new URLSearchParams(params);
      query.set('per_page', String(size));
      query.set('page', String(page));
      const res = await this.send(`${this.base}${path}?${query}`);
      const data = (await res.json()) as T[];
      rows.push(...data);
      if (!hasNextPage(res) || data.length < size) break;
    }
    return limit !== undefined ? rows.slice(0, limit) : rows;
  }

  /** `GET /notifications`: the user's unread threads updated after `since`.
   *  With `ifModifiedSince` it is the conditional request GitHub's polling
   *  contract asks for: an unchanged feed answers 304 and costs no quota. */
  async listNotifications(input: {
    since?: string;
    before?: string;
    participating?: boolean;
    ifModifiedSince?: string;
    limit?: number;
  }): Promise<GithubNotificationsAnswer> {
    const threads: GithubThread[] = [];
    let first: { lastModified?: string; date?: string; pollIntervalSeconds?: number } | undefined;
    for (let page = 1; ; page++) {
      const size = input.limit !== undefined ? Math.min(NOTIFICATIONS_PAGE_SIZE, Math.max(input.limit - threads.length, 0)) : NOTIFICATIONS_PAGE_SIZE;
      if (size === 0) break;
      const query = new URLSearchParams({ per_page: String(size), page: String(page) });
      if (input.since !== undefined) query.set('since', input.since);
      if (input.before !== undefined) query.set('before', input.before);
      if (input.participating === true) query.set('participating', 'true');
      // Only the first page is conditional: once the feed has changed, the
      // rest of it is read whole.
      const conditional = page === 1 && input.ifModifiedSince !== undefined ? { 'If-Modified-Since': input.ifModifiedSince } : undefined;
      const res = await this.send(`${this.base}/notifications?${query}`, conditional !== undefined ? { headers: conditional } : {});
      if (res.status === 304) {
        const interval = pollInterval(res);
        return { modified: false, ...(interval !== undefined ? { pollIntervalSeconds: interval } : {}) };
      }
      if (first === undefined) {
        const lastModified = res.headers.get('last-modified') ?? undefined;
        const date = res.headers.get('date') ?? undefined;
        const interval = pollInterval(res);
        first = {
          ...(lastModified !== undefined ? { lastModified } : {}),
          ...(date !== undefined ? { date } : {}),
          ...(interval !== undefined ? { pollIntervalSeconds: interval } : {}),
        };
      }
      const data = (await res.json()) as GithubThread[];
      threads.push(...data);
      if (!hasNextPage(res) || data.length < size) break;
    }
    return { modified: true, threads, ...first };
  }

  /** `GET /user/repos`: what the token's user owns, collaborates on, or
   *  reaches through an organisation, by full name. */
  listRepositories(limit?: number): Promise<GithubRepository[]> {
    return this.pages<GithubRepository>('/user/repos', new URLSearchParams({ sort: 'full_name' }), limit);
  }

  /** `GET /repos/{owner}/{repo}`. */
  getRepository(ref: GithubRepoRef): Promise<GithubRepository> {
    return this.json<GithubRepository>(repoPath(ref));
  }

  /** `GET /repos/{owner}/{repo}/pulls`, newest first. */
  listPullRequests(ref: GithubRepoRef, input: { state: 'open' | 'closed' | 'all'; limit?: number }): Promise<GithubPullRequest[]> {
    return this.pages<GithubPullRequest>(`${repoPath(ref)}/pulls`, new URLSearchParams({ state: input.state }), input.limit);
  }

  /** `GET /repos/{owner}/{repo}/issues`, newest first, without the pull
   *  requests GitHub's issues listing also returns (they have their own
   *  edge). A `limit` counts issues, so the pages run on until it is met. */
  async listIssues(ref: GithubRepoRef, query: GithubIssueQuery, limit?: number): Promise<GithubIssue[]> {
    const params = new URLSearchParams({ state: query.state });
    if (query.labels !== undefined && query.labels.length > 0) params.set('labels', query.labels.join(','));
    if (query.assignee !== undefined) params.set('assignee', query.assignee);
    if (query.creator !== undefined) params.set('creator', query.creator);
    if (query.since !== undefined) params.set('since', query.since);
    const issues: GithubIssue[] = [];
    for (let page = 1; limit === undefined || issues.length < limit; page++) {
      params.set('per_page', String(PAGE_SIZE));
      params.set('page', String(page));
      const res = await this.send(`${this.base}${repoPath(ref)}/issues?${params}`);
      const data = (await res.json()) as GithubIssue[];
      issues.push(...data.filter((issue) => issue.pull_request === undefined));
      if (!hasNextPage(res) || data.length < PAGE_SIZE) break;
    }
    return limit !== undefined ? issues.slice(0, limit) : issues;
  }

  /** `GET /repos/{owner}/{repo}/issues/{number}/comments`, oldest first. A
   *  pull request's conversation is its issue's comments. */
  listComments(ref: GithubRepoRef, number: number, input: { since?: string; limit?: number } = {}): Promise<GithubIssueComment[]> {
    const params = new URLSearchParams();
    if (input.since !== undefined) params.set('since', input.since);
    return this.pages<GithubIssueComment>(`${repoPath(ref)}/issues/${number}/comments`, params, input.limit);
  }

  /** `POST /repos/{owner}/{repo}/issues/{number}/comments` (201). */
  async createComment(ref: GithubRepoRef, number: number, body: string): Promise<GithubIssueComment> {
    const res = await this.send(`${this.base}${repoPath(ref)}/issues/${number}/comments`, { method: 'POST', body: { body } });
    return (await res.json()) as GithubIssueComment;
  }

  /** `POST /repos/{owner}/{repo}/issues/{number}/labels`: adds, never
   *  replaces. Answers every label the issue now carries. */
  async addLabels(ref: GithubRepoRef, number: number, names: string[]): Promise<GithubLabel[]> {
    const res = await this.send(`${this.base}${repoPath(ref)}/issues/${number}/labels`, { method: 'POST', body: { labels: names } });
    return (await res.json()) as GithubLabel[];
  }

  /**
   * Follow an API link GitHub handed back (a notification's `subject.url`).
   * Only a link under this client's own base is followed, so the token never
   * travels to a host the credential did not name.
   */
  async follow<T>(url: string): Promise<T> {
    if (!url.startsWith(`${this.base}/`)) {
      this.log.warn(`[github] not following ${url}: it is not under ${this.base}`);
      throw new Error(`GitHub: the link ${url} is not under the credential's API base ${this.base}; not following it with the token.`);
    }
    return (await (await this.send(url)).json()) as T;
  }
}

function repoPath(ref: GithubRepoRef): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

// ── Normalisation — the flat field bags `describe` advertises ───────────────

export function normalizeRepository(repo: GithubRepository): GithubRepositoryPayload {
  return {
    owner: repo.owner.login,
    repo: repo.name,
    id: String(repo.id),
    name: repo.name,
    full_name: repo.full_name,
    description: repo.description ?? null,
    private: repo.private,
    fork: repo.fork,
    archived: repo.archived ?? false,
    default_branch: repo.default_branch ?? null,
    html_url: repo.html_url,
    created_at: repo.created_at ?? null,
    updated_at: repo.updated_at ?? null,
    pushed_at: repo.pushed_at ?? null,
  };
}

export function normalizeNotification(thread: GithubThread): GithubNotificationPayload {
  return {
    id: thread.id,
    reason: thread.reason,
    unread: thread.unread,
    updated_at: thread.updated_at,
    last_read_at: thread.last_read_at,
    title: thread.subject.title,
    subject_type: thread.subject.type,
    subject_url: thread.subject.url,
    repository: normalizeRepository(thread.repository),
  };
}

export function normalizeLabel(label: GithubLabel): GithubLabelPayload {
  return { id: String(label.id), name: label.name, color: label.color ?? null, description: label.description ?? null };
}

function logins(users: GithubSimpleUser[] | null | undefined): string[] {
  return (users ?? []).map((u) => u.login);
}

/** The label objects of an issue; the issues listing may spell one as its
 *  bare name. */
function labelObjects(labels: Array<GithubLabel | string>): GithubLabelPayload[] {
  return labels.map((label) =>
    typeof label === 'string' ? { id: label, name: label, color: null, description: null } : normalizeLabel(label),
  );
}

export function normalizePullRequest(pr: GithubPullRequest, ref: GithubRepoRef): GithubPullRequestPayload {
  const labels = labelObjects(pr.labels);
  return {
    owner: ref.owner,
    repo: ref.repo,
    id: String(pr.id),
    number: pr.number,
    title: pr.title,
    body: pr.body ?? null,
    state: pr.state,
    author: pr.user?.login ?? null,
    html_url: pr.html_url,
    created_at: pr.created_at,
    updated_at: pr.updated_at,
    closed_at: pr.closed_at,
    assignees: logins(pr.assignees),
    label_names: labels.map((l) => l.name),
    labels,
    draft: pr.draft ?? false,
    merged: pr.merged_at !== null,
    merged_at: pr.merged_at,
    requested_reviewers: logins(pr.requested_reviewers),
    head_ref: pr.head?.ref ?? null,
    base_ref: pr.base?.ref ?? null,
  };
}

export function normalizeIssue(issue: GithubIssue, ref: GithubRepoRef): GithubIssuePayload {
  const labels = labelObjects(issue.labels);
  return {
    owner: ref.owner,
    repo: ref.repo,
    id: String(issue.id),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? null,
    state: issue.state,
    state_reason: issue.state_reason ?? null,
    author: issue.user?.login ?? null,
    html_url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.closed_at,
    assignees: logins(issue.assignees),
    label_names: labels.map((l) => l.name),
    labels,
    comments: issue.comments,
  };
}

export function normalizeComment(comment: GithubIssueComment): GithubCommentPayload {
  return {
    id: String(comment.id),
    body: comment.body ?? '',
    author: comment.user?.login ?? null,
    author_association: comment.author_association ?? null,
    html_url: comment.html_url,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
  };
}
