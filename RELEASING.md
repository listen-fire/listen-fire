# Releasing

This repository releases the language: the crates on crates.io, the `@listen-fire/*` packages on npm, the `lf` binaries and the documentation site. The platform's images are released from `lf-platform`, in the same GitHub organisation, under its own `v*` tags. The two version numbers were aligned once, at 0.12.0, and are independent from then on.

## Pre-release 0.12.0-rc.6 (run in this order, from a clean `main`)

Every crate and every `@listen-fire/*` package is at `0.12.0-rc.6`.
A suffixed tag never moves npm `latest` or the default docs.

0. After bumping the version (and before anything below), rebuild the committed
   wasm artifacts and commit them: the crate versions change the build's
   metadata, so `packages/movement-lang/wasm/*.wasm` no longer reproduce until
   rebuilt, and CI's byte check (`movement-wasm.yml`) would fail.
   ```sh
   rm -rf target/movement-wasm && scripts/build-movement-wasm.sh
   git add packages/movement-lang/wasm && git commit -m "build(wasm): artifacts rebuilt for <version>"
   ```
1. Push the branch.
   ```sh
   git push origin main
   ```
2. Push the three tags, in separate pushes: GitHub creates no push event when more than three tags arrive in one push, and a tag pushed together with others has gone unbuilt before. `v*` marks the crates and npm release; `lf-v*` builds the `lf` binaries and the pre-release GitHub release; `docs-v*` publishes the docs under `/docs/next/`.
   ```sh
   git tag v0.12.0-rc.6 && git tag lf-v0.12.0-rc.6 && git tag docs-v0.12.0-rc.6
   git push origin v0.12.0-rc.6 lf-v0.12.0-rc.6 docs-v0.12.0-rc.6
   ```
3. Publish the crates, in dependency order (wait a minute between each for the index).
   ```sh
   cargo publish -p listen-fire-parser
   cargo publish -p listen-fire-checker
   cargo publish -p listen-fire-engine
   cargo publish -p listen-fire-language
   cargo publish -p listen-fire-module-wire
   cargo publish -p listen-fire
   cargo publish -p listen-fire-module-kit
   ```
   A pre-release version is never picked by `cargo install listen-fire` without `--version 0.12.0-rc.6`.
4. Publish the npm packages; each has `publishConfig.tag: "next"`, so none takes `latest`.
   ```sh
   pnpm -r build
   pnpm -r publish --tag next --access public --no-git-checks
   ```
   (`pnpm -r publish` publishes in dependency order and skips private packages.)
5. Verify every public package landed (a recursive publish in one burst has
   dropped packages twice); republish any that are missing with `--filter`:
   ```sh
   for f in $(git ls-files '*/package.json' | grep -vE '^(apps/|examples/)'); do
     n=$(node -e "const j=require('./$f'); if(!j.private&&j.name) console.log(j.name)");
     [ -z "$n" ] && continue
     npm view "$n@0.12.0-rc.6" version >/dev/null 2>&1 || echo "MISSING $n"
   done
   pnpm -r --filter <missing-name> publish --tag next --access public --no-git-checks
   ```

## Promoting to a full release

1. Set the version (workspace `Cargo.toml`, the `version = "…"` of each path dependency in `crates/*/Cargo.toml`, every published `package.json`) to the plain version, e.g. `0.12.0`. Update `Cargo.lock`.
2. In `CHANGELOG.md`, rename the pre-release heading to the version and date, and drop the "preview" wording once it is no longer true.
3. Repeat the steps above with plain tags (`v0.12.0`, `lf-v0.12.0`, `docs-v0.12.0`): the GitHub release is a full release, docs become the default.
4. npm: publish without `--tag next`, or move `latest` explicitly: `npm dist-tag add @listen-fire/<name>@0.12.0 latest`. Remove `publishConfig.tag` from the packages before publishing, otherwise they still take `next`.

Note: `0.12.0-rc.6` sorts above the released `0.11.0` and below `0.12.0`. The docs stay under `/docs/next/` until the plain `docs-v0.12.0` tag publishes `/docs/v5/` (and the language server's links switch with the crate version).

A release names the language versions it supports (version 5 only) in its CHANGELOG entry. The platform adopts a language release by raising the versions of the `@listen-fire/*` packages it installs.
