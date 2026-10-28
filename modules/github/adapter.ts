// GitHub adapter — repositories, pull requests, issues, their comments and
// labels, and the authenticated user's notifications feed.
//
// The feed is a POLLED source: event production is the module's `poll`
// (poll.ts), driven by the host. This is the read and write half. The type
// graph is `schema.ts`; the WHERE pushdown is `filter.ts`; the write bodies
// are `write.ts`.

import type {
  Adapter,
  DeleteInput,
  DeleteResult,
  EdgesFromResult,
  EventType,
  GetFieldValueInput,
  GetRelatedInput,
  RelatedResult,
  UpdateInput,
  UpdateResult,
  WriteInput,
  WriteResult,
} from 'movement-engine/public/adapter';
import type { SchemaEntryPoint, SchemaTypeDescriptor, SourcePosition } from 'movement-engine/public/catalog';

import {
  ADAPTER_META_TYPE_ID,
  META_RECORD_TYPE,
  makeStablePosition,
  positionData,
} from 'movement-engine/public/catalog';
import { BaseAdapter } from 'module-kit/adapter/base';
import { uniformWalk } from 'module-kit/adapter/hop';
import { naturalName } from 'module-kit/adapter/name_resolution';
import {
  normalizeComment,
  normalizeIssue,
  normalizeNotification,
  normalizePullRequest,
  normalizeRepository,
  type GithubClient,
  type GithubIssue,
  type GithubPullRequest,
} from './api_client';
import { issueQueryFromWhere, pinnedRepository, pullQueryFromWhere, updatedWindowFromWhere } from './filter';
import { GITHUB_MANIFEST } from './manifest';
import { GITHUB_ACCOUNT_DESCRIPTOR, GITHUB_ROOT, describeGithubType, githubEntryPoints } from './schema';
import { createGithubRecord, writableTypeId } from './write';
import {
  GITHUB_ACCOUNT_TYPE_ID,
  GITHUB_ADAPTER_TYPE,
  GITHUB_COMMENTS_EDGE,
  GITHUB_COMMENT_DISPLAY_NAME,
  GITHUB_ISSUE_DISPLAY_NAME,
  GITHUB_LABELS_EDGE,
  GITHUB_LABEL_DISPLAY_NAME,
  GITHUB_NOTIFICATIONS_COLLECTION,
  GITHUB_NOTIFICATION_DISPLAY_NAME,
  GITHUB_NOTIFICATION_EVENT_TAG,
  GITHUB_NOTIFICATION_TYPE_ID,
  GITHUB_PULL_REQUEST_DISPLAY_NAME,
  GITHUB_REPOSITORIES_COLLECTION,
  GITHUB_REPOSITORY_DISPLAY_NAME,
  GITHUB_REPOSITORY_EDGE,
  GITHUB_REPO_ISSUES_EDGE,
  GITHUB_REPO_PULLS_EDGE,
  GITHUB_SUBJECT_ISSUE_EDGE,
  GITHUB_SUBJECT_PULL_EDGE,
  type GithubIssuePayload,
  type GithubLabelPayload,
  type GithubNotificationPayload,
  type GithubPullRequestPayload,
  type GithubRepoRef,
  type GithubRepositoryPayload,
} from './types';

/** Where the adapter and the poll get a credentialed client. */
export type GithubClientSource = () => Promise<GithubClient>;

export class GithubAdapter extends BaseAdapter implements Adapter {
  readonly adapterType = GITHUB_ADAPTER_TYPE;
  readonly supportedTriggers = GITHUB_MANIFEST.supportedTriggers;

  /** `client` hands back a credentialed client per call — the module's from
   *  its context, a test's over a fake — and throws, naming why, when there is
   *  no usable credential. */
  constructor(private readonly client: GithubClientSource) {
    super();
  }

  // ── 1. Schema introspection ────────────────────────────────────────────

  async listEntryPoints(): Promise<SchemaEntryPoint[]> {
    return githubEntryPoints();
  }

  async describe(typeRef: string): Promise<SchemaTypeDescriptor | null> {
    if (typeRef === ADAPTER_META_TYPE_ID || typeRef === GITHUB_ACCOUNT_TYPE_ID) return GITHUB_ACCOUNT_DESCRIPTOR;
    return describeGithubType(await this.resolveTypeRef(typeRef));
  }

  async edgesFrom(position: SourcePosition): Promise<EdgesFromResult | null> {
    return uniformWalk({
      adapterType: GITHUB_ADAPTER_TYPE,
      at: position,
      root: GITHUB_ROOT,
      describe: (typeId) => this.describe(typeId),
    });
  }

  // ── 2. Field-level access ──────────────────────────────────────────────
  // Every position carries its record inline, keyed by field id, so the
  // base class's lookup reads it.

  async getFieldValue(input: GetFieldValueInput): Promise<unknown> {
    if (input.position.adapterType !== GITHUB_ADAPTER_TYPE) {
      throw new Error(`GithubAdapter.getFieldValue received a position from a different adapter ('${input.position.adapterType}').`);
    }
    return super.getFieldValue(input);
  }

  // ── 3. Traversal ───────────────────────────────────────────────────────

  async getRelated(input: GetRelatedInput): Promise<RelatedResult[]> {
    if (input.position.adapterType !== GITHUB_ADAPTER_TYPE) {
      throw new Error(`GithubAdapter.getRelated received a position from a different adapter ('${input.position.adapterType}').`);
    }
    if (input.direction !== 'outgoing') return [];

    // The root's collection names cross VERBATIM (a meta position carries no
    // type to resolve an edge against), so match them before the resolver.
    if (input.position.recordType === META_RECORD_TYPE) return this.rootCollection(input);

    const edgeId = await this.resolveEdgeReadId(input.position.recordType, input.fieldId);
    const data = (positionData(input.position) ?? {}) as Record<string, unknown>;

    switch (edgeId) {
      case GITHUB_REPO_PULLS_EDGE: {
        const repo = data as unknown as GithubRepositoryPayload;
        const { state, exact } = pullQueryFromWhere(input.where);
        const client = await this.client();
        const pulls = await client.listPullRequests(repo, { state, ...limitOf(input, exact) });
        return pulls.map((pr) => pullPosition(pr, repo));
      }
      case GITHUB_REPO_ISSUES_EDGE: {
        const repo = data as unknown as GithubRepositoryPayload;
        const { query, exact } = issueQueryFromWhere(input.where);
        const client = await this.client();
        const issues = await client.listIssues(repo, query, limitOf(input, exact).limit);
        return issues.map((issue) => issuePosition(issue, repo));
      }
      case GITHUB_REPOSITORY_EDGE: {
        // A notification carries its repository whole; a pull request or an
        // issue carries where it lives, so the repository is fetched.
        if (input.position.recordType === GITHUB_NOTIFICATION_DISPLAY_NAME) {
          return [repositoryPosition((data as unknown as GithubNotificationPayload).repository)];
        }
        const ref = repoRefOf(data);
        if (ref === undefined) return [];
        const client = await this.client();
        return [repositoryPosition(normalizeRepository(await client.getRepository(ref)))];
      }
      case GITHUB_SUBJECT_PULL_EDGE:
      case GITHUB_SUBJECT_ISSUE_EDGE: {
        const notification = data as unknown as GithubNotificationPayload;
        const wanted = edgeId === GITHUB_SUBJECT_PULL_EDGE ? 'PullRequest' : 'Issue';
        if (notification.subject_type !== wanted || typeof notification.subject_url !== 'string') return [];
        const client = await this.client();
        const ref = { owner: notification.repository.owner, repo: notification.repository.repo };
        return edgeId === GITHUB_SUBJECT_PULL_EDGE
          ? [pullPosition(await client.follow<GithubPullRequest>(notification.subject_url), ref)]
          : [issuePosition(await client.follow<GithubIssue>(notification.subject_url), ref)];
      }
      case GITHUB_COMMENTS_EDGE: {
        const parent = data as Partial<GithubIssuePayload>;
        const ref = repoRefOf(data);
        if (ref === undefined || typeof parent.number !== 'number') return [];
        const { since } = updatedWindowFromWhere(input.where);
        const client = await this.client();
        const comments = await client.listComments(ref, parent.number, {
          ...(since !== undefined ? { since } : {}),
          ...limitOf(input, input.where === undefined, 'Created At', 'asc'),
        });
        return comments.map((comment) => ({
          position: makeStablePosition({
            adapterType: GITHUB_ADAPTER_TYPE,
            recordType: GITHUB_COMMENT_DISPLAY_NAME,
            recordId: String(comment.id),
            data: normalizeComment(comment),
          }),
        }));
      }
      case GITHUB_LABELS_EDGE: {
        const labels = ((data as Partial<GithubIssuePayload>).labels ?? []) as GithubLabelPayload[];
        return labels.map((label) => ({
          position: makeStablePosition({
            adapterType: GITHUB_ADAPTER_TYPE,
            recordType: GITHUB_LABEL_DISPLAY_NAME,
            recordId: label.id,
            data: label,
          }),
        }));
      }
      default:
        return [];
    }
  }

  /** The root's collections: the token's repositories, and the unread inbox. */
  private async rootCollection(input: GetRelatedInput): Promise<RelatedResult[]> {
    const client = await this.client();
    switch (input.fieldId) {
      case GITHUB_REPOSITORIES_COLLECTION: {
        const pinned = pinnedRepository(input.where);
        if (pinned !== undefined) return [repositoryPosition(normalizeRepository(await client.getRepository(pinned)))];
        const repos = await client.listRepositories(limitOf(input, input.where === undefined, 'Full Name', 'asc').limit);
        return repos.map((repo) => repositoryPosition(normalizeRepository(repo)));
      }
      case GITHUB_NOTIFICATIONS_COLLECTION: {
        const window = updatedWindowFromWhere(input.where);
        const answer = await client.listNotifications({ ...window, ...limitOf(input, input.where === undefined, 'Updated At', 'desc') });
        if (!answer.modified) return [];
        return answer.threads.map((thread) => ({
          position: makeStablePosition({
            adapterType: GITHUB_ADAPTER_TYPE,
            recordType: GITHUB_NOTIFICATION_DISPLAY_NAME,
            recordId: thread.id,
            data: normalizeNotification(thread),
          }),
        }));
      }
      default:
        return [];
    }
  }

  // ── 4. Writes ──────────────────────────────────────────────────────────

  async createRecord(rawInput: WriteInput): Promise<WriteResult> {
    const typeId = writableTypeId(await this.resolveTypeRef(rawInput.recordType));
    if (typeId === undefined) {
      throw new Error(`GithubAdapter.createRecord: "${rawInput.recordType}" cannot be created; GitHub's writes here are a Comment and a Label.`);
    }
    const resolver = await this.resolver({ types: [rawInput.recordType] });
    const type = naturalName(rawInput.recordType);
    const fields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawInput.fields)) {
      fields[resolver.tryFieldId(type, naturalName(key)) ?? key] = value;
    }
    const client = await this.client();
    return createGithubRecord({ client, typeId, write: { ...rawInput, fields } });
  }

  async updateRecord(input: UpdateInput): Promise<UpdateResult> {
    throw new Error(`GithubAdapter.updateRecord: changing a GitHub ${input.recordType} is not supported; this module adds comments and labels only.`);
  }

  async deleteRecord(input: DeleteInput): Promise<DeleteResult> {
    throw new Error(`GithubAdapter.deleteRecord: removing a GitHub ${input.recordType} is not supported; this module adds comments and labels only.`);
  }

  // ── 5. Event typing ────────────────────────────────────────────────────

  async listEventTypes(): Promise<EventType[]> {
    // The poll tags every event it produces, so discrimination is by tag.
    return [{ tag: GITHUB_NOTIFICATION_EVENT_TAG, positionType: GITHUB_NOTIFICATION_TYPE_ID, match: { path: 'id', equals: [] } }];
  }
}

// ── Position minting ────────────────────────────────────────────────────────
// Every record here has a durable GitHub id, so every position is stable, and
// each carries the repository it lives in so the next hop needs no lookup.

function repositoryPosition(repo: GithubRepositoryPayload): RelatedResult {
  return {
    position: makeStablePosition({ adapterType: GITHUB_ADAPTER_TYPE, recordType: GITHUB_REPOSITORY_DISPLAY_NAME, recordId: repo.id, data: repo }),
  };
}

function pullPosition(pr: GithubPullRequest, ref: GithubRepoRef): RelatedResult {
  const data: GithubPullRequestPayload = normalizePullRequest(pr, ref);
  return {
    position: makeStablePosition({ adapterType: GITHUB_ADAPTER_TYPE, recordType: GITHUB_PULL_REQUEST_DISPLAY_NAME, recordId: data.id, data }),
  };
}

function issuePosition(issue: GithubIssue, ref: GithubRepoRef): RelatedResult {
  const data: GithubIssuePayload = normalizeIssue(issue, ref);
  return {
    position: makeStablePosition({ adapterType: GITHUB_ADAPTER_TYPE, recordType: GITHUB_ISSUE_DISPLAY_NAME, recordId: data.id, data }),
  };
}

function repoRefOf(data: Record<string, unknown>): GithubRepoRef | undefined {
  return typeof data.owner === 'string' && typeof data.repo === 'string' ? { owner: data.owner, repo: data.repo } : undefined;
}

/**
 * The LIMIT a fetch may take (`GetRelatedInput.limit`'s contract): only when
 * the hop's ORDER BY is absent or is the order GitHub already answers in, and
 * only when the WHERE was pushed exactly — n rows of a wider set, narrowed
 * afterwards, would be fewer than the n asked for.
 */
function limitOf(
  input: GetRelatedInput,
  exact: boolean,
  naturalField = 'Created At',
  naturalDirection: 'asc' | 'desc' = 'desc',
): { limit?: number } {
  if (input.limit === undefined || !exact) return {};
  const ordered = input.orderBy === undefined || (input.orderBy.fieldId === naturalField && input.orderBy.direction === naturalDirection);
  return ordered ? { limit: input.limit } : {};
}
