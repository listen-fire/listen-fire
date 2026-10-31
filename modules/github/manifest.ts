// GitHub's manifest: what the host's catalog, editor, handbook and checker
// read about the adapter, construction-free. Data only, so a host can list
// GitHub without loading the adapter.

import type { AdapterManifest } from 'movement-engine/public/adapter';

import { GITHUB_ADAPTER_TYPE, GITHUB_NOTIFICATIONS_COLLECTION, GITHUB_NOTIFICATION_DISPLAY_NAME, GITHUB_PARTICIPATING_FIELD } from './types';

const GITHUB_HANDBOOK_CONTENT = `GitHub as a graph: your notifications feed, your repositories, their pull requests and issues, and each one's comments and labels. The credential is a personal access token; a program never holds it. The notifications feed takes only a classic token (scopes \`notifications\` and \`repo\`); a fine-grained one reaches repositories, pull requests and issues.

### listening — your notifications

\`\`\`
function triage(n: <gh-[:Notifications]->>) {
  pr = only(n-[:\`Pull Request\`]->)
  …
}

listen to gh-[n:Notifications WHERE n.Reason IN ["review_requested", "mention", "assign"]]-> fire triage
\`\`\`

A listen fires once per notification thread that is new or has changed since the last poll — a new comment on a thread already delivered fires again. \`Reason\` selects GitHub's reasons (\`review_requested\`, \`mention\`, \`assign\`, \`team_mention\`, \`author\`, \`comment\`, \`state_change\`, …); leave it out for every reason. \`n.Participating == true\` keeps only threads you take part in or are mentioned in. The FIRST poll sets the mark and delivers nothing, so going live never replays your inbox — walk \`Notifications\` for what is unread now. The feed is polled every minute (\`pollEvery\` in lf.yaml changes it for the connection); GitHub's own \`X-Poll-Interval\` is honoured, so a shorter one polls no faster. Listens on one connection with the same WHERE share one poll.

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
 * Static manifest. A polled source (the notifications feed has no webhook):
 * `Notifications` is a listenable edge a listen narrows by `Reason`, an enum,
 * so `listen-fire check` refuses a reason GitHub does not send. A target for
 * two writes.
 */
export const GITHUB_MANIFEST: AdapterManifest = {
  adapterType: GITHUB_ADAPTER_TYPE,
  displayName: 'GitHub',
  website: 'https://github.com',
  description:
    'GitHub notifications, repositories, pull requests and issues. Run a movement on ' +
    'each new review request or mention, read pull requests and issues, comment and label.',
  authoringHints:
    'Listen on Notifications for review requests, mentions and assignments; a WHERE on ' +
    'Reason selects them. Walk a notification’s Pull Request or Issue edge for the subject — no ids or ' +
    'URLs to parse. Pin State on a repository’s Pull Requests and Issues: both hold closed ' +
    'records too. A comment is written along Comments, a label along Labels; nothing else ' +
    'is writable.',
  handbookSection: {
    title: 'GitHub — notifications, pull requests and issues',
    content: GITHUB_HANDBOOK_CONTENT,
  },
  triggerExpectation:
    'Fires once per notification thread that is new or changed since the last poll ' +
    '(unread threads, as GitHub’s feed holds them); a WHERE on `Reason` narrows by ' +
    'reason. The first poll sets the mark and emits nothing. Polls are conditional ' +
    '(an unchanged feed is a 304) and never sooner than GitHub’s `X-Poll-Interval`. ' +
    '`Participating == true` keeps threads you take part in.',
  supportedTriggers: ['poll'],
  methods: ['listEntryPoints', 'describe', 'edgesFrom', 'getFieldValue', 'getRelated', 'createRecord'],
  requiredCredentialType: 'GITHUB',
  // A 0.12 `listen to gh { events: [...], participating: true }` is
  // `listen to gh-[n:Notifications WHERE n.Reason IN [...] AND n.Participating == true]->`
  // (`listen-fire upgrade`).
  listenSettingsBecome: {
    path: [GITHUB_NOTIFICATIONS_COLLECTION],
    aliases: ['n'],
    paramFrom: GITHUB_NOTIFICATION_DISPLAY_NAME,
    keys: {
      events: { hop: 0, field: 'Reason', op: 'in' },
      participating: { hop: 0, field: GITHUB_PARTICIPATING_FIELD, op: 'eq' },
    },
  },
  triggerKinds: ['GITHUB'],
  vocabulary: {
    // GitHub's mark (the Octocat), one filled path.
    icon: {
      d: 'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
      fill: true,
      viewBox: '0 0 24 24',
    },
    eventPhrase: {
      default: [{ template: 'When a GitHub notification arrives' }],
    },
  },
};
