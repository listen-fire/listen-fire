// GitHub's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// GitHub without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { GITHUB_ADAPTER_TYPE, GITHUB_NOTIFICATION_REASONS } from './types';

const GITHUB_HANDBOOK_CONTENT = `GitHub as a graph: your notifications feed, your repositories, their pull requests and issues, and each one's comments and labels. The credential is a personal access token; a program never holds it. The notifications feed takes only a classic token (scopes \`notifications\` and \`repo\`); a fine-grained one reaches repositories, pull requests and issues.

### listening — your notifications

\`\`\`
function triage(n: <gh-[:Notification]->>) {
  pr = only(n-[:\`Pull Request\`]->)
  …
}

listen to gh { events: ["review_requested", "mention", "assign"] } fire triage
\`\`\`

A listen fires once per notification thread that is new or has changed since the last poll — a new comment on a thread already delivered fires again. \`events\` selects GitHub's reasons (\`review_requested\`, \`mention\`, \`assign\`, \`team_mention\`, \`author\`, \`comment\`, \`state_change\`, …); leave it out for every reason. \`participating: true\` keeps only threads you take part in or are mentioned in. The FIRST poll sets the mark and delivers nothing, so going live never replays your inbox — walk \`Notifications\` for what is unread now. GitHub sets how often its feed may be polled (a minute, usually); a shorter \`every\` polls no faster.

A notification's \`Reason\`, \`Title\` and \`Subject Type\` say why and what about. Walk \`Pull Request\` or \`Issue\` for the subject itself (nothing when it is something else, a release or a discussion), and \`Repository\` for where.

### reading — repositories, pull requests, issues

\`\`\`
repo = only(gh-[r:Repositories WHERE r.\`Full Name\` == "acme/api"]->)
open = repo-[p:\`Pull Requests\` WHERE p.State == "open" AND p.Draft == false]->
\`\`\`

\`Full Name\` pinned with \`==\` fetches that one repository; otherwise \`Repositories\` lists the ones you own, collaborate on or reach through an organisation. \`Pull Requests\` and \`Issues\` hold open and closed records, newest first: pin \`State\` to keep the fetch small. On \`Issues\`, \`State\`, \`Author\`, a label in \`Label Names\`, an assignee and an \`Updated At\` lower bound reach GitHub; other filters run over what comes back. \`Issues\` never includes pull requests.

Field names are GitHub's: \`Number\`, \`Title\`, \`Body\`, \`State\`, \`HTML URL\`, \`Author\` (the login), \`Assignees\`, \`Label Names\`, \`Created At\`, \`Updated At\`; a pull request adds \`Draft\`, \`Merged\`, \`Merged At\`, \`Requested Reviewers\`, \`Head Ref\` and \`Base Ref\`.

### writing — a comment, a label

\`\`\`
write pr-[:Comments]-> { Body: "Looking at this today." }
write issue-[:Labels]-> { Name: "triaged" }
\`\`\`

A comment goes into the conversation (a pull request's issue comments, not a review). Adding a label the record already carries changes nothing; one the repository lacks is created. Nothing else is written: no reviews, merges, closes or edits.`;

/**
 * Static manifest. A polled source (the notifications feed has no webhook)
 * and a target for two writes. Nothing is SUBSCRIBED to: `subscribableEvents`
 * is the reason vocabulary, which the poll labels each event with, so a
 * listen's `events` narrows by reason and `lf check` refuses a reason GitHub
 * does not send.
 */
export const GITHUB_MANIFEST: AdapterManifest = {
  adapterType: GITHUB_ADAPTER_TYPE,
  displayName: 'GitHub',
  website: 'https://github.com',
  description:
    'GitHub notifications, repositories, pull requests and issues. Run a movement on ' +
    'each new review request or mention, read pull requests and issues, comment and label.',
  authoringHints:
    'Listen on Notification for review requests, mentions and assignments; events selects ' +
    'reasons. Walk a notification’s Pull Request or Issue edge for the subject — no ids or ' +
    'URLs to parse. Pin State on a repository’s Pull Requests and Issues: both hold closed ' +
    'records too. A comment is written along Comments, a label along Labels; nothing else ' +
    'is writable.',
  handbookSection: {
    title: 'GitHub — notifications, pull requests and issues',
    content: GITHUB_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'Fires once per notification thread that is new or changed since the last poll ' +
    '(unread threads, as GitHub’s feed holds them), labelled with its reason, so ' +
    '`events` narrows by reason. The first poll sets the mark and emits nothing. Polls ' +
    'are conditional (an unchanged feed is a 304) and never sooner than GitHub’s ' +
    '`X-Poll-Interval`. `participating: true` keeps threads you take part in.',
  supportedTriggers: ['poll'],
  methods: ['listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated', 'createRecord'],
  requiredCredentialType: 'GITHUB',
  subscribableEvents: [...GITHUB_NOTIFICATION_REASONS],
  listenConfig: [
    { key: 'participating', required: false },
    { key: 'pollIntervalSeconds', required: false },
  ],
  triggerKinds: ['GITHUB'],
  vocabulary: {
    // GitHub's mark (the Octocat), one filled path.
    icon: {
      d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
      fill: true,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      review_requested: [{ template: 'When your review is requested on GitHub' }],
      mention: [{ template: 'When you are mentioned on GitHub' }],
      assign: [{ template: 'When you are assigned on GitHub' }],
      default: [{ template: 'When a GitHub notification arrives' }],
    },
  },
};
