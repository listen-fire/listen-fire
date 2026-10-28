// GitHub adapter — the names and ids the rest of the package shares, the poll
// checkpoint, and the flat payloads positions carry.
//
// The ONE rule (module-kit adapter/base.ts): a position's `recordType` is the
// pretty DISPLAY NAME; the `github:*` typeIds below are this adapter's private
// currency and never ride a position.

export const GITHUB_ADAPTER_TYPE = 'github';

/** The account meta node a movement obtains by constructing the adapter. */
export const GITHUB_ACCOUNT_TYPE_ID = 'github:account';
export const GITHUB_ACCOUNT_DISPLAY_NAME = 'GitHub';

export const GITHUB_NOTIFICATION_TYPE_ID = 'github:notification';
export const GITHUB_NOTIFICATION_DISPLAY_NAME = 'Notification';

export const GITHUB_REPOSITORY_TYPE_ID = 'github:repository';
export const GITHUB_REPOSITORY_DISPLAY_NAME = 'Repository';

export const GITHUB_PULL_REQUEST_TYPE_ID = 'github:pull_request';
export const GITHUB_PULL_REQUEST_DISPLAY_NAME = 'Pull Request';

export const GITHUB_ISSUE_TYPE_ID = 'github:issue';
export const GITHUB_ISSUE_DISPLAY_NAME = 'Issue';

export const GITHUB_COMMENT_TYPE_ID = 'github:comment';
export const GITHUB_COMMENT_DISPLAY_NAME = 'Comment';

export const GITHUB_LABEL_TYPE_ID = 'github:label';
export const GITHUB_LABEL_DISPLAY_NAME = 'Label';

// ── Root collections (Title Case, plural, distinct from the type each yields)

export const GITHUB_REPOSITORIES_COLLECTION = 'Repositories';
export const GITHUB_NOTIFICATIONS_COLLECTION = 'Notifications';

// ── Edges below the root: read id (private) ↔ natural name (what authors write)

export const GITHUB_REPO_PULLS_EDGE = 'repo_pulls';
export const GITHUB_REPO_PULLS_EDGE_NAME = 'Pull Requests';
export const GITHUB_REPO_ISSUES_EDGE = 'repo_issues';
export const GITHUB_REPO_ISSUES_EDGE_NAME = 'Issues';
export const GITHUB_REPOSITORY_EDGE = 'repository';
export const GITHUB_REPOSITORY_EDGE_NAME = 'Repository';
export const GITHUB_SUBJECT_PULL_EDGE = 'subject_pull';
export const GITHUB_SUBJECT_PULL_EDGE_NAME = 'Pull Request';
export const GITHUB_SUBJECT_ISSUE_EDGE = 'subject_issue';
export const GITHUB_SUBJECT_ISSUE_EDGE_NAME = 'Issue';
export const GITHUB_COMMENTS_EDGE = 'comments';
export const GITHUB_COMMENTS_EDGE_NAME = 'Comments';
export const GITHUB_LABELS_EDGE = 'labels';
export const GITHUB_LABELS_EDGE_NAME = 'Labels';

// ── Vocabularies ─────────────────────────────────────────────────────────────

/** Why the user got a notification: GitHub's documented `reason` values
 *  (REST "Activity › Notifications", 2022-11-28). They are also the `events:`
 *  vocabulary, so a listen selects reasons and `lf check` refuses a misspelt
 *  one. */
export const GITHUB_NOTIFICATION_REASONS = [
  'agent_session_finished',
  'approval_requested',
  'assign',
  'author',
  'ci_activity',
  'comment',
  'invitation',
  'manual',
  'member_feature_requested',
  'mention',
  'review_requested',
  'security_advisory_credit',
  'security_alert',
  'state_change',
  'subscribed',
  'team_mention',
] as const;

/** What a notification is about (`subject.type`). GitHub documents no closed
 *  list, so these are known values, not an enum. */
export const GITHUB_SUBJECT_TYPES = [
  'PullRequest',
  'Issue',
  'Commit',
  'Release',
  'Discussion',
  'CheckSuite',
  'RepositoryVulnerabilityAlert',
  'RepositoryDependabotAlertsThread',
] as const;

/** An issue's or a pull request's `state`. Merged is a closed pull request
 *  with `merged_at` set (`Merged`). */
export const GITHUB_STATES = ['open', 'closed'] as const;

/** The discriminator every polled notification event carries. */
export const GITHUB_NOTIFICATION_EVENT_TAG = 'github:notification';

/** The opaque checkpoint the poll persists. */
export interface GithubCheckpoint {
  /** The newest `updated_at` already delivered (ISO). */
  updatedAfter: string;
  /** The `Last-Modified` of the last full answer, sent back as
   *  `If-Modified-Since` so an unchanged feed costs a 304. */
  lastModified?: string;
  /** Epoch ms before which GitHub asked not to be polled again
   *  (`X-Poll-Interval`). */
  pollAfter?: number;
}

/** Where a record lives: what every repository-scoped call is addressed by.
 *  Carried on each payload the adapter mints, never parsed out of a URL. */
export interface GithubRepoRef {
  owner: string;
  repo: string;
}

// ── Payloads: the flat field bags positions carry, keyed by field id ─────────

export interface GithubRepositoryPayload extends GithubRepoRef {
  id: string;
  name: string;
  full_name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string | null;
  html_url: string;
  created_at: string | null;
  updated_at: string | null;
  pushed_at: string | null;
}

export interface GithubNotificationPayload {
  id: string;
  reason: string;
  unread: boolean;
  updated_at: string;
  last_read_at: string | null;
  title: string;
  subject_type: string;
  /** The API URL of the subject, followed by the `Pull Request` / `Issue`
   *  edges (GitHub's own link, so no number is parsed out of it). */
  subject_url: string | null;
  repository: GithubRepositoryPayload;
}

/** The fields a pull request and an issue share. */
interface GithubIssueLikePayload extends GithubRepoRef {
  id: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  author: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  assignees: string[];
  label_names: string[];
  labels: GithubLabelPayload[];
}

export interface GithubPullRequestPayload extends GithubIssueLikePayload {
  draft: boolean;
  merged: boolean;
  merged_at: string | null;
  requested_reviewers: string[];
  head_ref: string | null;
  base_ref: string | null;
}

export interface GithubIssuePayload extends GithubIssueLikePayload {
  state_reason: string | null;
  comments: number;
}

export interface GithubCommentPayload {
  id: string;
  body: string;
  author: string | null;
  author_association: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
}

export interface GithubLabelPayload {
  id: string;
  name: string;
  color: string | null;
  description: string | null;
}
