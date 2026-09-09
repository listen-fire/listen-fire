# Security policy

## Reporting a vulnerability

Report security vulnerabilities privately, by email, to **security@listen-fire.dev**.

<!-- TODO: confirm security@listen-fire.dev is a mailbox you actually read before this repository goes public. -->

Please do not open a public GitHub issue, pull request or discussion for a vulnerability, and please do not describe one in a public channel. A public report tells everyone running Listen-Fire about the problem at the same moment it tells us, and self-hosted installations cannot be patched centrally.

If you would prefer an encrypted channel, say so in a first message with no details in it and we will arrange one.

## Supported versions

`main` is the only supported version. There are no long-lived release branches and no backports; a fix lands on `main`, and self-hosted installations pick it up by rebuilding their images from a newer commit.

## What to include

The more of this a report carries, the faster it can be confirmed:

- What the vulnerability lets an attacker do, stated as an outcome: read another team's data, act as another user, run code in the container.
- The commit or image tag you found it on.
- Which units the installation was running (`core`, `knowledge`, `automations`, `valuations`, `asks`) and whether it was a `core` or single-tenant deployment, since the identity model differs between them.
- Steps to reproduce, or a proof of concept. A request and its response is usually enough.
- Anything about the deployment that mattered: reverse proxy, TLS termination, whether the API and web app share an origin.

Please do not include credentials, personal data, or the contents of anyone's real workspace. A redacted reproduction is more useful than a real one.

## What happens next

This project is maintained by a very small team, so please expect a human rather than an automated pipeline. We aim to acknowledge a report within a few working days and to follow up with an assessment once we have reproduced it. We will tell you if something is going to take a while rather than leave the thread quiet.

We will credit you in the release notes for the fix unless you ask us not to. There is no bug bounty.

## Scope

In scope: the code in this repository, the container images built from `deploy/`, and the deployment guidance in `deploy/SELF_HOSTING.md` and `deploy/guides/`.

Out of scope: vulnerabilities in third-party services Listen-Fire connects to (report those to the service), and findings against an installation you do not operate and are not authorised to test.
