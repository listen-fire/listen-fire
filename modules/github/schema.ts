// The GitHub type graph: the entry surface and every type descriptor.
//
// The shape follows GitHub's own nouns. An account reaches repositories and
// its notifications feed; a repository holds pull requests and issues; a pull
// request or an issue holds its conversation (comments) and its labels; a
// notification is ABOUT one subject, reached along `Pull Request` or `Issue`
// rather than by an id the program would have to carry. Field names are
// GitHub's (`html_url` reads as `HTML URL`, `user.login` as `Author`), so a
// program written against the REST docs reads as it expects and `lf check`
// refuses a field GitHub does not have.
//
// Everything here is STATIC — no credential, no network — so `describe` is
// free and the walk hydrates every target rather than stubbing.

import type { SchemaEntryPoint, SchemaFieldDescriptor, SchemaReferenceDescriptor, SchemaTypeDescriptor } from 'movement-engine/public/catalog';

import { META_RECORD_TYPE } from 'movement-engine/public/catalog';
import {
  GITHUB_ACCOUNT_DISPLAY_NAME,
  GITHUB_ACCOUNT_TYPE_ID,
  GITHUB_COMMENTS_EDGE,
  GITHUB_COMMENTS_EDGE_NAME,
  GITHUB_COMMENT_DISPLAY_NAME,
  GITHUB_COMMENT_TYPE_ID,
  GITHUB_ISSUE_DISPLAY_NAME,
  GITHUB_ISSUE_TYPE_ID,
  GITHUB_LABELS_EDGE,
  GITHUB_LABELS_EDGE_NAME,
  GITHUB_LABEL_DISPLAY_NAME,
  GITHUB_LABEL_TYPE_ID,
  GITHUB_NOTIFICATIONS_COLLECTION,
  GITHUB_NOTIFICATION_DISPLAY_NAME,
  GITHUB_NOTIFICATION_REASONS,
  GITHUB_NOTIFICATION_TYPE_ID,
  GITHUB_PULL_REQUEST_DISPLAY_NAME,
  GITHUB_PULL_REQUEST_TYPE_ID,
  GITHUB_REPOSITORIES_COLLECTION,
  GITHUB_REPOSITORY_DISPLAY_NAME,
  GITHUB_REPOSITORY_EDGE,
  GITHUB_REPOSITORY_EDGE_NAME,
  GITHUB_REPOSITORY_TYPE_ID,
  GITHUB_REPO_ISSUES_EDGE,
  GITHUB_REPO_ISSUES_EDGE_NAME,
  GITHUB_REPO_PULLS_EDGE,
  GITHUB_REPO_PULLS_EDGE_NAME,
  GITHUB_STATES,
  GITHUB_SUBJECT_ISSUE_EDGE,
  GITHUB_SUBJECT_ISSUE_EDGE_NAME,
  GITHUB_SUBJECT_PULL_EDGE,
  GITHUB_SUBJECT_PULL_EDGE_NAME,
  GITHUB_SUBJECT_TYPES,
} from './types';

/** A read-only field; `extra` carries what differs. */
function field(
  fieldId: string,
  displayName: string,
  kind: SchemaFieldDescriptor['kind'],
  extra: Partial<SchemaFieldDescriptor> = {},
): SchemaFieldDescriptor {
  return { fieldId, displayName, kind, writable: false, required: false, ...extra };
}

/**
 * A listing GitHub filters by query parameters and sorts by its own default
 * (newest first). The WHERE fields it takes are each field's
 * `filterOperators`; the rest runs over what comes back.
 */
const NEWEST_FIRST = {
  filter: 'native',
  order: 'bounded',
  supportsLimit: true,
  naturalOrder: { field: 'Created At', direction: 'desc' },
} as const;

/** An edge bounded by the record it leaves: a conversation, a label set. Any
 *  WHERE and ORDER BY are satisfied over what comes back. */
const BOUNDED_BY_PARENT = { filter: 'bounded', order: 'bounded', supportsLimit: true } as const;

const REPOSITORIES_DESCRIPTION =
  'Repositories the token reaches: the ones you own, collaborate on, or reach ' +
  'through an organisation, by full name. A WHERE `Full Name` == "owner/name" ' +
  'fetches that one repository directly (any the token can read).';

const NOTIFICATIONS_DESCRIPTION =
  'Your unread notifications now — the inbox github.com/notifications shows. ' +
  'An `Updated At` bound reaches GitHub; other filters run over what comes back. ' +
  'Listen on `Notification` to be told about new ones instead.';

export function githubEntryPoints(): SchemaEntryPoint[] {
  return [
    {
      typeId: GITHUB_REPOSITORY_TYPE_ID,
      displayName: GITHUB_REPOSITORY_DISPLAY_NAME,
      writable: false,
      readable: true,
      collectionName: GITHUB_REPOSITORIES_COLLECTION,
      description: REPOSITORIES_DESCRIPTION,
    },
    {
      typeId: GITHUB_NOTIFICATION_TYPE_ID,
      displayName: GITHUB_NOTIFICATION_DISPLAY_NAME,
      writable: false,
      readable: true,
      collectionName: GITHUB_NOTIFICATIONS_COLLECTION,
      description: NOTIFICATIONS_DESCRIPTION,
    },
    // The EVENT edge onto the same node the readable collection lands on (two
    // edges, two promises, one node): the inbox can be read, and a new or
    // changed thread is delivered.
    {
      typeId: GITHUB_NOTIFICATION_TYPE_ID,
      displayName: GITHUB_NOTIFICATION_DISPLAY_NAME,
      writable: false,
      readable: false,
      fires: true,
      description:
        'Delivered once per notification thread that is new or has changed since ' +
        'the last poll. `events` selects reasons (["review_requested", "mention"]).',
    },
    // Reached only through a parent, never enumerated from the root.
    { typeId: GITHUB_PULL_REQUEST_TYPE_ID, displayName: GITHUB_PULL_REQUEST_DISPLAY_NAME, writable: false, readable: false },
    { typeId: GITHUB_ISSUE_TYPE_ID, displayName: GITHUB_ISSUE_DISPLAY_NAME, writable: false, readable: false },
    { typeId: GITHUB_COMMENT_TYPE_ID, displayName: GITHUB_COMMENT_DISPLAY_NAME, writable: false, readable: false },
    { typeId: GITHUB_LABEL_TYPE_ID, displayName: GITHUB_LABEL_DISPLAY_NAME, writable: false, readable: false },
  ];
}

/** The account meta node — what this connection IS, and the edges leaving it. */
export const GITHUB_ROOT: SchemaTypeDescriptor = {
  typeId: META_RECORD_TYPE,
  displayName: GITHUB_ACCOUNT_DISPLAY_NAME,
  description:
    'The GitHub account the token belongs to. Walk `Repositories` for pull requests ' +
    'and issues, `Notifications` for the unread inbox; listen on `Notification` to ' +
    'be told about new ones.',
  fields: [],
  references: [
    {
      fieldId: GITHUB_REPOSITORIES_COLLECTION,
      targetTypeId: GITHUB_REPOSITORY_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GITHUB_REPOSITORIES_COLLECTION,
      description: REPOSITORIES_DESCRIPTION,
      capability: { filter: 'native', order: 'bounded', supportsLimit: true },
    },
    {
      fieldId: GITHUB_NOTIFICATIONS_COLLECTION,
      targetTypeId: GITHUB_NOTIFICATION_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GITHUB_NOTIFICATIONS_COLLECTION,
      description: NOTIFICATIONS_DESCRIPTION,
      capability: { filter: 'native', order: 'bounded', supportsLimit: true },
    },
    {
      fieldId: `fires:${GITHUB_NOTIFICATION_TYPE_ID}`,
      targetTypeId: GITHUB_NOTIFICATION_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: GITHUB_NOTIFICATION_DISPLAY_NAME,
      fires: true,
      readable: false,
      description: 'A notification thread, new or changed — what a listen delivers.',
    },
  ],
};

const REPOSITORY_EDGE: SchemaReferenceDescriptor = {
  fieldId: GITHUB_REPOSITORY_EDGE,
  targetTypeId: GITHUB_REPOSITORY_TYPE_ID,
  cardinality: 'one',
  direction: 'outgoing',
  name: GITHUB_REPOSITORY_EDGE_NAME,
  required: true,
  description: 'The repository it belongs to.',
};

const COMMENTS_EDGE: SchemaReferenceDescriptor = {
  fieldId: GITHUB_COMMENTS_EDGE,
  targetTypeId: GITHUB_COMMENT_TYPE_ID,
  cardinality: 'many',
  direction: 'outgoing',
  name: GITHUB_COMMENTS_EDGE_NAME,
  description:
    'The conversation, oldest first (a pull request’s are its issue comments, ' +
    'not its review comments). Comment here: `write pr-[:Comments]-> { Body: "…" }`.',
  writable: true,
  sequenced: 'chronological',
  capability: { ...BOUNDED_BY_PARENT, naturalOrder: { field: 'Created At', direction: 'asc' } },
};

const LABELS_EDGE: SchemaReferenceDescriptor = {
  fieldId: GITHUB_LABELS_EDGE,
  targetTypeId: GITHUB_LABEL_TYPE_ID,
  cardinality: 'many',
  direction: 'outgoing',
  name: GITHUB_LABELS_EDGE_NAME,
  description:
    'The labels it carries. Add one: `write issue-[:Labels]-> { Name: "bug" }` ' +
    '(GitHub creates a label the repository does not have yet; adding one it ' +
    'already carries changes nothing).',
  writable: true,
  capability: BOUNDED_BY_PARENT,
};

const NOTIFICATION_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GITHUB_NOTIFICATION_TYPE_ID,
  displayName: GITHUB_NOTIFICATION_DISPLAY_NAME,
  description:
    'A notification thread: why you were told (`Reason`), what about (`Title`, ' +
    '`Subject Type`), and where. Walk `Pull Request` or `Issue` for the subject itself.',
  fields: [
    field('id', 'Id', 'string', { required: true, description: 'The thread id.' }),
    field('reason', 'Reason', 'enum', { required: true, enumValues: [...GITHUB_NOTIFICATION_REASONS], description: 'Why you got it (`review_requested`, `mention`, `assign`, …). A thread’s reason can change as it moves.' }),
    field('unread', 'Unread', 'boolean', { required: true }),
    field('updated_at', 'Updated At', 'date', { required: true, capability: { filterOperators: ['gt', 'gte', 'lt', 'lte'] } }),
    field('last_read_at', 'Last Read At', 'date'),
    field('title', 'Title', 'string', { required: true, description: 'The subject’s title (`subject.title`).' }),
    field('subject_type', 'Subject Type', 'string', { required: true, knownValues: [...GITHUB_SUBJECT_TYPES], description: 'What it is about (`subject.type`): `PullRequest`, `Issue`, `Release`, `Discussion`, `Commit`, `CheckSuite`, …' }),
  ],
  references: [
    { ...REPOSITORY_EDGE, description: 'The repository the thread is in.' },
    {
      fieldId: GITHUB_SUBJECT_PULL_EDGE,
      targetTypeId: GITHUB_PULL_REQUEST_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: GITHUB_SUBJECT_PULL_EDGE_NAME,
      description: 'The pull request it is about; nothing when `Subject Type` is not `PullRequest`.',
    },
    {
      fieldId: GITHUB_SUBJECT_ISSUE_EDGE,
      targetTypeId: GITHUB_ISSUE_TYPE_ID,
      cardinality: 'one',
      direction: 'outgoing',
      name: GITHUB_SUBJECT_ISSUE_EDGE_NAME,
      description: 'The issue it is about; nothing when `Subject Type` is not `Issue`.',
    },
  ],
};

const REPOSITORY_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GITHUB_REPOSITORY_TYPE_ID,
  displayName: GITHUB_REPOSITORY_DISPLAY_NAME,
  description: 'A repository: its pull requests and its issues.',
  fields: [
    field('name', 'Name', 'string', { required: true }),
    field('full_name', 'Full Name', 'string', { required: true, description: '`owner/name`. An `==` in a `Repositories` WHERE fetches that repository directly.', capability: { filterOperators: ['eq'] } }),
    field('owner', 'Owner', 'string', { required: true, description: 'The owner’s login (`owner.login`).' }),
    field('description', 'Description', 'string'),
    field('private', 'Private', 'boolean', { required: true }),
    field('fork', 'Fork', 'boolean', { required: true }),
    field('archived', 'Archived', 'boolean'),
    field('default_branch', 'Default Branch', 'string'),
    field('html_url', 'HTML URL', 'string', { required: true }),
    field('id', 'Id', 'string', { required: true }),
    field('created_at', 'Created At', 'date'),
    field('updated_at', 'Updated At', 'date'),
    field('pushed_at', 'Pushed At', 'date'),
  ],
  references: [
    {
      fieldId: GITHUB_REPO_PULLS_EDGE,
      targetTypeId: GITHUB_PULL_REQUEST_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GITHUB_REPO_PULLS_EDGE_NAME,
      description:
        'Pull requests, open and closed, newest first. `State` reaches GitHub; ' +
        'other filters run over what comes back, so pin `State` == "open" on a busy repository.',
      sequenced: 'chronological',
      capability: NEWEST_FIRST,
    },
    {
      fieldId: GITHUB_REPO_ISSUES_EDGE,
      targetTypeId: GITHUB_ISSUE_TYPE_ID,
      cardinality: 'many',
      direction: 'outgoing',
      name: GITHUB_REPO_ISSUES_EDGE_NAME,
      description:
        'Issues (not pull requests), open and closed, newest first. `State`, ' +
        '`Author`, a label in `Label Names`, an assignee in `Assignees` and an ' +
        '`Updated At` lower bound reach GitHub.',
      sequenced: 'chronological',
      capability: NEWEST_FIRST,
    },
  ],
};

/** The fields a pull request and an issue share, GitHub's names for both. */
function issueLikeFields(): SchemaFieldDescriptor[] {
  return [
    field('number', 'Number', 'number', { required: true }),
    field('title', 'Title', 'string', { required: true }),
    field('body', 'Body', 'string'),
    field('state', 'State', 'enum', { required: true, enumValues: [...GITHUB_STATES], capability: { filterOperators: ['eq'] } }),
    field('author', 'Author', 'string', { description: 'The login of who opened it (`user.login`).' }),
    field('html_url', 'HTML URL', 'string', { required: true }),
    field('created_at', 'Created At', 'date', { required: true }),
    field('updated_at', 'Updated At', 'date', { required: true }),
    field('closed_at', 'Closed At', 'date'),
    field('assignees', 'Assignees', 'string', { cardinality: 'many', description: 'The assignees’ logins.' }),
    field('label_names', 'Label Names', 'string', { cardinality: 'many', description: 'The names of its labels; `Labels` are the labels themselves.' }),
    field('id', 'Id', 'string', { required: true }),
  ];
}

const PULL_REQUEST_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GITHUB_PULL_REQUEST_TYPE_ID,
  displayName: GITHUB_PULL_REQUEST_DISPLAY_NAME,
  description: 'A pull request. Comment on it along `Comments`; label it along `Labels`.',
  fields: [
    ...issueLikeFields(),
    field('draft', 'Draft', 'boolean'),
    field('merged', 'Merged', 'boolean', { description: 'Closed by merging (`merged_at` is set).' }),
    field('merged_at', 'Merged At', 'date'),
    field('requested_reviewers', 'Requested Reviewers', 'string', { cardinality: 'many', description: 'The logins asked to review it.' }),
    field('head_ref', 'Head Ref', 'string', { description: 'The branch it merges from (`head.ref`).' }),
    field('base_ref', 'Base Ref', 'string', { description: 'The branch it merges into (`base.ref`).' }),
  ],
  references: [COMMENTS_EDGE, LABELS_EDGE, REPOSITORY_EDGE],
};

const ISSUE_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GITHUB_ISSUE_TYPE_ID,
  displayName: GITHUB_ISSUE_DISPLAY_NAME,
  description: 'An issue. Comment on it along `Comments`; label it along `Labels`.',
  fields: [
    ...issueLikeFields().map((f) => {
      if (f.fieldId === 'author') return { ...f, capability: { filterOperators: ['eq' as const] } };
      if (f.fieldId === 'label_names' || f.fieldId === 'assignees') return { ...f, capability: { filterOperators: ['contains' as const] } };
      if (f.fieldId === 'updated_at') return { ...f, capability: { filterOperators: ['gt' as const, 'gte' as const] } };
      return f;
    }),
    field('state_reason', 'State Reason', 'string', { description: 'Why it was closed (`completed`, `not_planned`, …), or reopened.' }),
    field('comments', 'Comment Count', 'number', { required: true, description: 'How many comments it has (`comments`).' }),
  ],
  references: [COMMENTS_EDGE, LABELS_EDGE, REPOSITORY_EDGE],
};

const COMMENT_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GITHUB_COMMENT_TYPE_ID,
  displayName: GITHUB_COMMENT_DISPLAY_NAME,
  description: 'A comment in a pull request’s or an issue’s conversation.',
  fields: [
    field('body', 'Body', 'string', { writable: true, required: true, description: 'The comment, in GitHub Markdown.' }),
    field('author', 'Author', 'string', { description: 'The commenter’s login (`user.login`).' }),
    field('author_association', 'Author Association', 'string', { description: '`OWNER`, `MEMBER`, `CONTRIBUTOR`, `NONE`, …' }),
    field('html_url', 'HTML URL', 'string'),
    field('created_at', 'Created At', 'date'),
    field('updated_at', 'Updated At', 'date'),
    field('id', 'Id', 'string'),
  ],
  references: [],
  // A comment is a new post every time; there is nothing to match it against.
  uniquenessAuthorable: false,
};

const LABEL_DESCRIPTOR: SchemaTypeDescriptor = {
  typeId: GITHUB_LABEL_TYPE_ID,
  displayName: GITHUB_LABEL_DISPLAY_NAME,
  description: 'A label on a pull request or an issue.',
  fields: [
    field('name', 'Name', 'string', { writable: true, required: true }),
    field('color', 'Color', 'string', { description: 'Hex, without the `#`.' }),
    field('description', 'Description', 'string'),
    field('id', 'Id', 'string'),
  ],
  references: [],
  // Adding is idempotent on the name at GitHub's end already.
  uniquenessAuthorable: false,
};

const DESCRIPTORS: Record<string, SchemaTypeDescriptor> = {
  [GITHUB_NOTIFICATION_TYPE_ID]: NOTIFICATION_DESCRIPTOR,
  [GITHUB_REPOSITORY_TYPE_ID]: REPOSITORY_DESCRIPTOR,
  [GITHUB_PULL_REQUEST_TYPE_ID]: PULL_REQUEST_DESCRIPTOR,
  [GITHUB_ISSUE_TYPE_ID]: ISSUE_DESCRIPTOR,
  [GITHUB_COMMENT_TYPE_ID]: COMMENT_DESCRIPTOR,
  [GITHUB_LABEL_TYPE_ID]: LABEL_DESCRIPTOR,
};

/** The account meta descriptor — the node `edgesFrom` roots at, addressed by
 *  type id (author-time introspection reaches it that way). */
export const GITHUB_ACCOUNT_DESCRIPTOR: SchemaTypeDescriptor = {
  ...GITHUB_ROOT,
  typeId: GITHUB_ACCOUNT_TYPE_ID,
};

/** `describe` over an already-resolved INTERNAL type id. Null for an id this
 *  adapter does not own. */
export function describeGithubType(typeId: string): SchemaTypeDescriptor | null {
  return DESCRIPTORS[typeId] ?? null;
}
