# Bring your own identity

Listen-Fire sees identity through one small contract. A product never reads an accounts table, never calls an auth middleware, and never learns which identity system is behind it — it gets opaque ids and an access level, and that is the whole of what it knows.

That is what makes replacing identity tractable. It is also what makes the effort estimate honest, because everything a product needs from a person is enumerable, and it is enumerated below.

Two implementations ship. The **static** provider is one tenant, one shared key, no infrastructure — the floor. The **core** provider is the full worked example: sessions, API keys, teams, memberships, impersonation. If neither is what you want, you have two routes, and they differ by an order of magnitude in effort. Read §5 and §6 before you pick.

---

## 1. The contract

These interfaces *are* the documentation. They are quoted verbatim from `packages/principal/`, comments included, because the comments carry rulings that a paraphrase would lose.

### `Principal` — `packages/principal/principal.ts`

```ts
type Access = 'read' | 'write';

interface Principal {
  /** Opaque tenant id — the only scoping key. */
  readonly teamId: string;
  /** Absent for machine principals (inbound webhooks, schedulers, workers). */
  readonly userId?: string;
  readonly access: Access;
  /** Opaque to core; '*' grants everything. */
  readonly scopes: readonly string[];
  /** null = the credential spans the subject's memberships rather than one team. */
  readonly pinnedTeamId: string | null;
  /** Audit / rate-limit handle. Never parsed. */
  readonly credentialId?: string;
}

interface TeamRef {
  teamId: string;
  name: string;
  access: Access;
  /** A person's own workspace (team-of-one) rather than a shared/org team.
   *  Team identity, not authorization: a picker names it differently, and the
   *  MCP surface already returns it. */
  isPersonal: boolean;
}

/**
 * Not express's Request: products mount the same provider under express, Next
 * route handlers, and MCP transports, so the request a provider authenticates
 * is only the two lookups every one of those can answer.
 */
interface PrincipalRequest {
  readonly method: string;
  readonly url: string;
  header(name: string): string | undefined;
  cookie(name: string): string | undefined;
}

type PrincipalResult =
  | { ok: true; principal: Principal }
  | { ok: false; status: 401 | 403; message: string; wwwAuthenticate?: string };

interface PrincipalProvider {
  authenticate(req: PrincipalRequest): Promise<PrincipalResult>;
  /** Team pickers, MCP listTeams. */
  listTeams(p: Principal): Promise<TeamRef[]>;
  /** Throws {@link TeamScopeError} when the request names a team the principal cannot act in. */
  resolveTeam(p: Principal, requested?: string): Promise<TeamRef>;
}

/** The team a caller asked for is not one this principal can act in — or the
 *  caller must name one and did not. Carries the accessible teams so an agent
 *  caller can recover without a separate listTeams round-trip. */
class TeamScopeError extends Error {
  readonly teams?: TeamRef[];
  // constructor(message: string, teams?: TeamRef[])
}
```

Three implementation points hide in there.

`PrincipalRequest` is not express's request, on purpose: a provider is mounted under express, under Next route handlers, and under MCP transports, so it may only ask the two questions all three can answer. If your identity system needs more than a header and a cookie to authenticate a request, that is a design constraint to resolve before you start, not during.

`credentialId` is a handle for auditing and rate limiting. It is **never parsed** — do not encode meaning in it and expect anything to read it back.

`TeamScopeError` carries the accessible teams because the caller is often an agent. Handing back the list is what lets it retry once instead of guessing.

### `Directory` — `packages/principal/directory.ts`

The second half, and the only place a product can learn a human fact about a person. Read-only, and **every lookup is team-scoped** except one deliberate exception.

```ts
/** `hasAccess` = the subject is a member of the team AND their account is
 *  activated. A caller that ignores it is admitting ungranted users. */
interface DirectoryUser {
  id: string;
  email?: string;
  displayName?: string;
  hasAccess: boolean;
}

/** One membership-verified tie between a login email and a team. Deliberately
 *  bare: it says who and where, and nothing about whether they may act. */
interface DirectoryTeamAssociation {
  teamId: string;
  userId: string;
}

interface Directory {
  userById(q: { id: string; teamId: string }): Promise<DirectoryUser | null>;
  userByEmail(q: { email: string; teamId: string }): Promise<DirectoryUser | null>;
  members(teamId: string): Promise<DirectoryUser[]>;
  team(id: string): Promise<{ id: string; name: string } | null>;
  teamsForEmail(email: string): Promise<DirectoryTeamAssociation[]>;
}
```

`teamsForEmail` is the one deliberate global-scope lookup in the contract, and its own doc comment explains why it exists and what it refuses to do:

> It exists because a channel door has no team until something resolves one: an inbound email arrives addressed to a per-team routing key, and the SENDER is what disambiguates which team's key was meant. […] It returns associations and never gates: membership is verified (an email whose owner belongs to no team resolves to nothing), but admission is the caller's policy — apply `userById`/`userByEmail`'s `hasAccess` per candidate team before acting on one. Returning an empty array is the honest answer for an unknown sender; it is not an error.

**`null` and `hasAccess: false` are different answers and must stay different.** `null` means "nobody by that identity belongs to this team". `hasAccess: false` means "we know them, and they may not act". Collapsing the two is how a flat lookup silently admits an ungranted user.

There are deliberately no phone lookups. The phone family belongs to automations, and a product reads its own tables rather than taking a Directory hop for data it owns.

### The ambient store — `packages/principal/ambient.ts`

One `AsyncLocalStorage`, process-wide, shipped in the package rather than left to each product. A composed deployment with four stores has four half-populated identities and no way to tell which one a call site read.

You almost certainly do not touch this. It matters for one reason: `currentPrincipal()` **throws** when there is none, because an unauthenticated call site reaching for identity is a bug, not a `read` principal. And `currentUserId()` throws for a machine principal, because a path that needs a person is asking a question a scheduler cannot answer — it says so rather than writing `undefined` into an author column.

### The express adapter — `packages/principal/express.ts`

`principalMiddleware({ provider })` resolves the request, answers the refusal itself (status, message, and `WWW-Authenticate` when the provider supplied one), and otherwise installs the principal in the ambient store for the rest of the chain. Mount it early: everything downstream reads identity off the store, so a route reached before it has no principal at all rather than a weaker one.

## 2. What a provider must guarantee

The types compile long before the behaviour is right. These are the invariants that are not expressible in the signature.

**Fail closed on access.** No membership is *not* a lesser access — it is none. A user id paired with a team they do not belong to yields no access at all, and every caller refuses. Core spells this out at `apps/api/src/services/principal/core_teams.ts`:

```ts
async function accessFor({
  userId,
  teamId,
}: {
  userId?: string;
  teamId: string;
}): Promise<Access | null> {
  if (userId === undefined) return 'write';
  const inTeam = (await membershipsOf(userId)).filter((m) => m.teamId === teamId);
  if (inTeam.length === 0) return null;
  return inTeam.every((m) => m.access === 'read') ? 'read' : 'write';
}
```

The `null` matters more than the `read`. Returning `write` for an unknown pair was the last echo of an older "home team" allowance: invisible on the request path, where team resolution has already rejected the pair, and load-bearing in background work, where nothing else checks. If your provider has any branch that answers "some access" when it cannot find a membership, that branch is a cross-tenant hole.

**A machine principal has a team and no person.** `userId` is absent for inbound webhooks, schedulers and workers, and the system acting on its own team is what a machine principal *means* — so it keeps team-scoped write. Do not fabricate a user id to satisfy a signature. Every attribution column that a machine principal cannot fill is already nullable; the four surfaces that genuinely need a person refuse instead, and §6 lists them.

**Team resolution has exactly three branches**, and `resolveTeam` must implement all three:

- **Pinned, or machine.** Always that team. A `requested` team that differs is *rejected*, not honoured — the credential may not be escaped.
- **User-anchored with `requested`.** Allowed if and only if they are a member.
- **User-anchored with `requested` omitted.** Their single team if they have exactly one. With several, refuse and hand back the list, so the caller retries once instead of the write silently landing somewhere plausible. With **none**, refuse outright — membership is the sole authority, so a user who belongs to nothing has nowhere to act.

That last case is the one people get wrong. Answering with "the team the credential happened to resolve as" is the same failure as the `accessFor` one above, wearing a different hat.

**Pinned teams are what makes an MCP connection safe.** `pinnedTeamId` is the difference between a credential that spans a person's memberships and one scoped to a single team. A pinned credential's `listTeams` returns exactly that team and its `resolveTeam` refuses any other, so an agent driving the connection cannot reach a tenant the connection was not issued for. A user-anchored credential (`pinnedTeamId: null`) lists every team its owner belongs to and requires the caller to name one when there is more than one. Both shapes are real and both must work; a provider that pins everything breaks multi-team agents, and one that pins nothing removes the only boundary a per-team connector has.

**Report the principal's own access, not a hopeful one.** A read-only credential whose `listTeams` reports its team as writable is a lie the caller only discovers at the failed write.

**`'*'` in `scopes` grants everything.** The contract says so, core mints it for a full-access key, and the static provider mints it by default. A gate that compares `'*'` as a literal scope name refuses the most ordinary configuration there is — which is exactly the bug that shipped in six copies of one gate before it was found.

## 3. The two shipped implementations

**The floor: the static provider.** `packages/principal/static/provider.ts`, `static/directory.ts` and `static/config.ts`, about 320 lines including the configuration parsing. One team, one secret, no infrastructure. `pinnedTeamId` is always the static team, so every "which team?" branch in product code takes the pinned path unchanged. Configuration is read once at boot and anything malformed is a boot failure, because a mis-set identity variable that degrades quietly is how a single-tenant install silently becomes an open one.

Read this one first. It is the smallest thing that satisfies the contract, and it is a working template.

**The full example: the core provider.** `apps/api/src/services/principal/`, about 800 lines across five files:

| file | what it is |
|---|---|
| `core_provider.ts` | the credential funnel — cookie session → API key → the public identity — and the shared tail: impersonation overlay, acting-team resolution, access level |
| `core_teams.ts` | `listTeams` / `resolveTeam` / `accessFor` against memberships |
| `core_directory.ts` | the `Directory`, read straight off `user` / `user_email` / `team_membership` |
| `mode.ts` | which identity this process runs on, read once |
| `index.ts` | the composition root — the only file that knows there is a choice |

Two things worth stealing from it. Product-owned inbound doors (an email callback, a webhook signature) do **not** re-implement authentication: they resolve their own credential and hand the identity back through the same `completeAuthentication` tail, so the membership gate cannot have a second implementation that drifts. And the websocket handshake is authenticated through the same provider, with the realtime token arriving as a subprotocol instead of a cookie — same claim, same secret, shorter life — so the whole chain applies unchanged.

## 4. Which route you are on

| | in front of core | replacing the provider |
|---|---|---|
| what you build | one more login method inside core | a `PrincipalProvider` + a `Directory` |
| what owns accounts | core's tables | your IdP |
| teams and memberships | core's | yours to model and map |
| status today | **not built** | supported; two implementations ship |
| effort | small, but somebody has to write it | a few hundred lines, plus the mapping decisions |

If your users have accounts in Okta, Entra or Google Workspace and you want them to sign in with those, and you are happy for Listen-Fire to keep owning teams and memberships, you want the first. If your organisation is the source of truth for teams and who is in them, you want the second.

## 5. SSO in front of core — the shape, and the honest status

**This is not built.** No OIDC login method exists in core today. What follows is the boundary it would sit on, so you can judge the work rather than discover it.

Core's login is already **four methods, not one**: a Google identity token, a Microsoft identity token, a passwordless emailed link, and a password. They all land under `/api/public/auth/*`, and every one of them ends the same way — verify the identity, resolve or provision the user, then set the `listen_fire_token` session cookie through one shared helper. Everything downstream reads that cookie: `core_provider.ts` looks it up first in the credential funnel, the websocket accepts the same claim as a short-lived realtime token, and the MCP surface treats its presence as a signed-in browser.

An OIDC login method is therefore an **addition beside those four**, not a layer above them:

1. A route that starts the authorization-code flow against your IdP.
2. A callback that validates the ID token and gets a verified email out of it.
3. Resolve or provision the user for that email, exactly as the Google and Microsoft handlers already do — and note that they route first-time logins through create-or-login on purpose, while the admin variant stays strict and provisions nobody.
4. Mint **the same session cookie** the other four mint.

Nothing about the Principal contract changes, because nothing below step 4 can tell which door the person came through. Core stays the identity; your IdP becomes one more way to prove you are a person core already knows about (or is willing to create).

The decisions that are actually yours, and that no code can make for you: whether a first-time SSO login provisions an account or is refused until invited; whether group claims map onto teams at all, or whether teams stay Listen-Fire-managed; and what happens when someone is deprovisioned in the IdP, since core's own gate is a `team_membership` row plus an activation flag, and neither disappears on its own.

If team membership must follow your IdP's groups, you have crossed into §6 whether or not you also built this.

## 6. Replacing the provider outright

Implement `PrincipalProvider` and `Directory` against your own system, register them at the composition root, and never touch a product file. This is the supported route, and the contract exists precisely so that it is a few hundred lines rather than a fork.

**The work is small; the mapping decisions are not.** Budget the thinking, not the typing:

- **What is a team?** Every row Listen-Fire writes carries one opaque tenant id. An IdP group, an organisation, a workspace — pick one and hold it forever, because changing the mapping later orphans everything created before the change.
- **What is a membership, and what is access?** The contract has exactly two access levels. Your model has to collapse onto `read` and `write`, and onto `null` for "not a member", per §2.
- **Which credentials do you accept?** A session cookie, a bearer token, both. `authenticate` sees a header lookup and a cookie lookup, and returns 401 or 403 with a message — plus `wwwAuthenticate` when your scheme wants a challenge.
- **What is pinned?** If you issue per-team API keys or per-team agent connections, those are pinned credentials. If you issue per-person tokens, they are user-anchored. Get this wrong in the pinned direction and multi-team users lose access to their other teams; wrong in the other direction and a connection issued for one tenant can reach the rest.

### What the four person-binding surfaces need from you

[`deploy/SELF_HOSTING.md`](../SELF_HOSTING.md) names four surfaces that refuse a machine principal with a 400 naming the fix, rather than inventing a user, because their whole job is to bind a thing to a **person**:

| surface | why it needs a person | what your provider must supply |
|---|---|---|
| connecting a credential | the link is stamped with who asked for it and the credential is named after them | a `Principal` with a real `userId`, and a `Directory` that answers `userById` for it in that team with a `displayName` |
| granting access to a specific file or folder | a grant is one account's grant | the same `userId`, stable across sessions — a grant recorded against an id you re-mint is a grant nobody can revoke |
| linking a WhatsApp number | a number belongs to somebody's login | a real `userId`; the link is stored against it |
| confirming the WhatsApp code | same | same |

Starting a new conversation with the authoring agent refuses for the same reason — the conversation records an owner, and that column is not nullable. Continuing an existing one keeps working.

Two consequences worth internalising before you design your ids.

**A provider that only ever produces machine principals produces a deployment where those five things are unreachable.** That is the static provider's shape, stated honestly rather than papered over. It is a supported deployment; it is just not one in which anyone connects a Google account.

**Do not fabricate a user id to make the refusals go away.** The static provider has an optional `LISTEN_FIRE_USER_ID` for attribution, and setting it does exactly this: it hands a person-shaped id to code paths that were about to tell you honestly that they need a person. It masks the entire class. The variable exists for a name on records, not to unlock the four surfaces above, and a deployment that only works with it set is reporting a bug.

**Email is the join.** Several channel doors resolve a team from an inbound sender's address, through `teamsForEmail`. If your identity system does not expose a verified login email per user, those doors cannot route, and you should decide deliberately that they are out of scope rather than discovering it when mail arrives.

## 7. Wiring it in

One environment variable selects the identity, read once at boot:

```
LISTEN_FIRE_PRINCIPAL=core     # default — the tables in this database
LISTEN_FIRE_PRINCIPAL=static   # one team, one secret, no infrastructure
```

An unrecognised value is a **boot failure**, not a silent fall back to `core`. The two modes are different security postures and a typo must not pick one.

The composition root is `apps/api/src/services/principal/index.ts`. It is the only file in the tree that knows there is a choice; no product code branches on the answer. A third mode is a third branch in `compose()` and a third value in `mode.ts`, and nothing else:

```ts
function compose(): Identity {
  const mode = principalMode();
  if (mode === 'static') {
    const config = staticConfigFromEnv(process.env);
    return {
      mode,
      provider: createStaticPrincipalProvider(config),
      directory: createStaticDirectory(config.directory),
    };
  }
  return { mode, provider: createCorePrincipalProvider(), directory: coreDirectory };
}
```

**One invariant is checked at boot in both directions: `core` in `LISTEN_FIRE_PRODUCTS` and `LISTEN_FIRE_PRINCIPAL=core` imply each other.** Core's login routes exist to mint exactly what core identity validates, so either half without the other is a deployment that cannot authenticate anybody — and it fails at boot rather than at the first request. There is no "static principal with core mounted" shape.

A third mode of your own has to answer the same question: does it need core's routes mounted? If it does not — and a provider against your own IdP does not — then it belongs with `core` **absent** from the product list, and the boot check has to learn about it. That check is the one place your change is not purely additive.

`LISTEN_FIRE_PRODUCTS` and `LISTEN_FIRE_PRINCIPAL` are composition, not operator input: `deploy/up.sh` sets them from the units you name, and the process checks the two against each other at boot in both directions.

## 8. Proving it works

The shipped implementations carry tests you can read as a specification: `packages/principal/static/__test__/provider.unit.test.ts` and `directory.unit.test.ts`, `packages/principal/__test__/express.unit.test.ts` and `ambient.unit.test.ts`, and core's own suite beside `apps/api/src/services/principal/`.

Cover these five before you trust a provider in front of real tenants:

1. A request with no credential is refused — and refused with the status your surfaces expect, not with a `read` principal.
2. A user id paired with a team they do not belong to yields **no** access, on the request path *and* in background work.
3. A pinned credential asked for a different team **throws** `TeamScopeError` rather than answering.
4. A user-anchored principal with several teams and no `team` argument throws, and the error carries the list.
5. A user in no team at all is refused outright rather than landing somewhere plausible.

Then boot the shape you intend to ship, in an environment that contains nothing but what the deployment ships. A proof run in a tree that has a `.env` proves nothing about a container: every "missing" variable is quietly present on a developer's machine, which is how three separate boot-blocking defects passed every earlier proof and failed the first time a real container ran.
