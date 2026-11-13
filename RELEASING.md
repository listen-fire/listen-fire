# Releasing

This repository releases the language: the crates on crates.io, the `@listen-fire/*` packages on npm, the `listen-fire` binaries and the documentation site. The platform's images are released from `lf-platform`, in the same GitHub organisation, under its own `v*` tags. The two version numbers were aligned once, at 0.12.0, and are independent from then on.

Two kinds of release exist, because two kinds of version exist.

## Which version moves

| What changed | Moves | Release |
| --- | --- | --- |
| The parser, checker, language or engine crate; `listen-fire` (the `listen-fire` crate); `movement-lang`, `engine` or `engine-contracts` | the core: those 5 crates and 3 packages, together, to the language's one version | core release |
| `module-runtime` (the engine depends on it) | the package, and a patch of the core | core release |
| Any other package (a module, `module-kit`, `embed`, `authoring-mcp`, `handbook`, `fake-channels`, `file-text`, `files-s3`, `model-providers`, `ocr-google`) | that package alone, on its own version | packages-only release |
| The `module-wire` or `module-kit` crate | that crate alone, on its own version (edit its `Cargo.toml`) | packages-only release |

- The language version is `packages/movement-lang/package.json`'s `version`. `scripts/release/sync-core-version.mjs` copies it everywhere else the core carries it, and CI runs `--check` on every push.
- Every package outside the core has its own `CHANGELOG.md` (changesets writes it). The root `CHANGELOG.md` is the language's.
- A module's contract with `listen-fire` is the adapter protocol minor its manifest states, not a core version. Its `peerDependencies` on the core are wide (`>=0.12.0 <1.0.0`); a core release that breaks `movement-engine/public/*`, `engine-contracts` or `movement-lang` exports raises the floor of each package it breaks, in its own changeset. A package that ships programs (the handbook, a module's handbook section) must also check under the oldest core its range admits; `node scripts/release/check-peer-floors.mjs` installs that release from npm and runs them through its checker, and the ship gate fails when a floor is too low.
- A bundled module reaches `listen-fire` users at the next `lf-v*` release, which builds the bundle from the tagged commit. Users who need a module sooner install it in their project: a project's own `node_modules` wins for a name the bundle does not carry. `listen-fire --version` lists the bundle's modules and their versions.

Every change to a published package adds a changeset (`corepack pnpm changeset`) naming the packages it touches and the bump.

### How the npm packages are published

CI stages them and a maintainer approves. `.github/workflows/npm-stage.yml` runs on every push to `main`: for each public package whose `name@version` npm lacks, it packs the package with pnpm (which rewrites the `workspace:` specifiers) and runs `npm stage publish` on the extracted tarball, with `--tag` from the package's `publishConfig.tag`, else `latest`. Staging uploads the release and holds it; nothing is live until the maintainer approves each package on npmjs.com (Staged Packages tab, with 2FA). `scripts/release/approve-npm-stages.mjs` approves them from the terminal instead (`--list` previews; it approves only versions in this checkout and reads the authenticator code from `npm_config_otp`). CI authenticates by npm trusted publishing, so no npm token is stored anywhere. Most pushes stage nothing, because every version is already on npm.

Trust is set per release, not once. Each package must name `npm-stage.yml` as a trusted publisher, and a new trust config expires unless its first successful publish happens within 2 days. So before the push that stages a release, run the trust script for the packages about to release (it takes the ones npm lacks; it asks for 2FA on the first call; `--dry-run` previews):
```sh
scripts/release/trust-npm-packages.sh
```
`scripts/release/stage-npm-packages.mjs --dry-run` previews what CI would stage, and stages nothing.

`scripts/release/npm-release-status.mjs` shows what is waiting: the versions npm lacks, which the trust script takes, and the ones CI has staged for approval (`--json` for tools).

If staging fails (npm's staged publishing is new, November 2026), see the fallback after the verify step.

## A core release (run in this order, from a clean `main`)

The core is at the new version; the plain tags move npm `latest`, make the GitHub release a full release and publish the docs as the default.

1. Write the changesets for the core group (`movement-lang`, `engine`, `engine-contracts` move together), and for any other package that changed.
2. Version the packages.
   ```sh
   corepack pnpm changeset version
   ```
3. Copy the core's new version to Cargo, `language_version_value.ts` and the README, and refresh the lockfiles.
   ```sh
   node scripts/release/sync-core-version.mjs
   cargo update -w
   corepack pnpm install
   ```
   On a new compatibility key (a new minor under 0.x), also upgrade the repository's own projects with the new binary: `listen-fire upgrade --dir <folder>` for each committed `lf.yaml` (the examples and `deploy/lf/project`). The sync script's `--check` fails while any still pins an older key.
4. Update `CHANGELOG.md` (the language's): move Unreleased under the new version's heading with its date, and say which pins the release no longer reads. Commit steps 2 to 4 as `release: <version>`.
5. Rebuild the committed wasm artifacts and commit them: the crate versions change the build's metadata, so `packages/movement-lang/wasm/*.wasm` no longer reproduce until rebuilt, and CI's byte check (`movement-wasm.yml`) would fail.
   ```sh
   rm -rf target/movement-wasm && scripts/build-movement-wasm.sh
   git add packages/movement-lang/wasm && git commit -m "build(wasm): artifacts rebuilt for <version>"
   ```
6. Trust the packages that will stage (see "How the npm packages are published"), then push the branch; the push stages the npm packages that moved.
   ```sh
   scripts/release/trust-npm-packages.sh
   git push origin main
   ```
7. Push the three tags, in separate pushes: GitHub creates no push event when more than three tags arrive in one push, and a tag pushed together with others has gone unbuilt before. `v*` marks the crates and npm release; `lf-v*` builds the `listen-fire` binaries and the GitHub release; `docs-v*` publishes the docs under `/docs/0.12/`. Then tag the packages (`changeset tag`) and push those; no workflow reads them.
   ```sh
   git tag v0.12.12 && git tag lf-v0.12.12 && git tag docs-v0.12.12
   git push origin v0.12.12
   git push origin lf-v0.12.12
   git push origin docs-v0.12.12
   corepack pnpm changeset tag && git push origin --tags
   ```
8. Publish the crates. The script publishes, in dependency order, each crate whose `name@version` is not yet on crates.io, waiting until cargo's package index (index.crates.io, which lags the crates.io website) carries each one before publishing the next. If the index is slow it stops after ten minutes; rerun it to continue, since a crate already published is skipped. `--dry-run` prints what it would publish.
   ```sh
   scripts/release/publish-crates.sh --dry-run
   scripts/release/publish-crates.sh
   ```
   `cargo install listen-fire` now picks the new version.
9. Approve the staged npm packages on npmjs.com (Staged Packages tab, 2FA) once the `npm-stage` run for the push has finished green. None has `publishConfig.tag`, so each is staged for `latest`. A package that moved but was not staged (the run failed) is a failure to read in the run's log, not to patch around.
10. Verify every public package landed (the loop has no `!`, which an interactive zsh would read as history). A missing package was not approved, or its stage failed:
    ```sh
    for f in $(git ls-files '*/package.json' | grep -vE '^(apps/|examples/)'); do
      n=$(node -e "const j=require('./$f'); j.private || (j.name && console.log(j.name+' '+j.version))");
      [ -z "$n" ] && continue
      npm view "${n% *}@${n#* }" version >/dev/null 2>&1 || echo "MISSING $n"
    done
    ```

#### Fallback: publish from the laptop

Only when staging cannot be made to work. A version already staged cannot be staged again, so approve or discard it first. This is the old path, with an authenticator code:
```sh
corepack pnpm -r build
corepack pnpm -r publish --access public --no-git-checks
```
`pnpm -r publish` skips any package whose version npm already has. Republish a package the verify loop reports missing with `corepack pnpm -r --filter <missing-name> publish --access public --no-git-checks`.

## A packages-only release (the language does not move)

No Cargo, wasm or `v*`/`lf-v*`/`docs-v*` step: the core's version, the crates and the binaries are untouched.

1. Write a changeset for each package that changed. A change to a package outside the core never bumps the core.
2. Version them; each package's `CHANGELOG.md` gets its entry. Check `git diff --stat` names only the packages you meant.
   ```sh
   corepack pnpm changeset version
   corepack pnpm install
   ```
   `node scripts/release/sync-core-version.mjs --check` stays clean, since the core did not move.
3. Commit `release: <package> <version>`, trust the packages that will stage, and push the branch; the push stages the npm packages that moved. Tag the packages and push those tags.
   ```sh
   scripts/release/trust-npm-packages.sh
   git push origin main
   corepack pnpm changeset tag && git push origin --tags
   ```
4. Approve the staged packages on npmjs.com, as in step 9 above.
5. If the `module-wire` or `module-kit` crate moved (its `version` in its own `Cargo.toml`, with the dependants' path dependency lines), run `scripts/release/publish-crates.sh`: it publishes only those.
6. Verify as in step 10 above (the fallback there is the same).

## Pre-release of the core, `0.13.0-rc.1` (run in this order, from a clean `main`)

The core is at `0.13.0-rc.1`; the three core packages carry `publishConfig.tag: "next"` for the pre-release (full releases carry none). A suffixed tag never moves npm `latest` or the default docs. Packages outside the core keep their own versions; they publish with the core's pre-release only if they changed.

1. Set the core's version: `packages/movement-lang/package.json`, `engine` and `engine-contracts` to `0.13.0-rc.1` (by hand, or `changeset version` in pre mode), then `node scripts/release/sync-core-version.mjs` and `cargo update -w`.
2. Rebuild and commit the wasm, as in step 5 above.
3. Push the branch, then the three tags in separate pushes (`v0.13.0-rc.1`, `lf-v0.13.0-rc.1`, `docs-v0.13.0-rc.1`). `lf-v*` makes the pre-release GitHub release; `docs-v*` publishes under `/docs/next/`.
4. `scripts/release/publish-crates.sh`. A pre-release version is never picked by `cargo install listen-fire` without `--version 0.13.0-rc.1`.
5. Run `scripts/release/trust-npm-packages.sh` before the branch push in step 3, so that push stages the packages. The core's three packages carry `publishConfig.tag: "next"`, which the staging script passes as `--tag next`, so the pre-release needs no extra flag and never takes `latest` (a staged tag cannot be changed later, so check the tag in `scripts/release/stage-npm-packages.mjs --dry-run` first). Approve them as in step 9 above, then verify as in step 10 above (with `0.13.0-rc.1`).

### Promoting the pre-release to a full release

1. Set the core's version to the plain one (`changeset version`, or by hand in `movement-lang`, `engine`, `engine-contracts`) and run `node scripts/release/sync-core-version.mjs`, `cargo update -w` and `corepack pnpm install`.
2. Remove `publishConfig.tag` from the three core packages (`git grep -n '"tag": "next"'`); left in, the package still publishes under `next`.
3. In `CHANGELOG.md`, add the version's heading with its date above the pre-releases' sections, which stay beneath it as history; drop the "preview" wording once it is no longer true, and say which pins the release no longer reads. Point the `[Unreleased]` link at the new tag.
4. Commit `release: <version>`, then run the core release from step 5, with plain tags (`v<version>`, `lf-v<version>`, `docs-v<version>`) and npm without `--tag next`.

Note: a pre-release such as `0.13.0-rc.1` sorts above the released `0.12.0` and below `0.13.0`. Its docs stay under `/docs/next/` until the plain `docs-v0.13.0` tag publishes `/docs/0.13/` (and the language server's links switch with the crate version).

A release's language version is its own semver; its CHANGELOG entry says which pins it no longer reads. The platform adopts a language release by raising the core's pin in its catalog, and a module's fix by raising that module's own pin.
