# Releasing

This repository releases the language: the crates on crates.io, the `@listen-fire/*` packages on npm, the `lf` binaries and the documentation site. The platform's images are released from `lf-platform`, in the same GitHub organisation, under its own `v*` tags. The two version numbers were aligned once, at 0.12.0, and are independent from then on.

## Full release 0.12.1 (run in this order, from a clean `main`)

Every crate and every `@listen-fire/*` package is at `0.12.1`.
The plain tags move npm `latest`, make the GitHub release a full release and publish the docs as the default.

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
2. Push the three tags, in separate pushes: GitHub creates no push event when more than three tags arrive in one push, and a tag pushed together with others has gone unbuilt before. `v*` marks the crates and npm release; `lf-v*` builds the `lf` binaries and the GitHub release; `docs-v*` publishes the docs under `/docs/0.12/`.
   ```sh
   git tag v0.12.1 && git tag lf-v0.12.1 && git tag docs-v0.12.1
   git push origin v0.12.1 lf-v0.12.1 docs-v0.12.1
   ```
3. Publish the crates, in dependency order (wait a minute between each for the index).
   ```sh
   cargo publish -p listen-fire-parser
   cargo publish -p listen-fire-checker
   cargo publish -p listen-fire-language
   cargo publish -p listen-fire-engine
   cargo publish -p listen-fire-module-wire
   cargo publish -p listen-fire
   cargo publish -p listen-fire-module-kit
   ```
   `cargo install listen-fire` now picks 0.12.1.
4. Publish the npm packages; none has `publishConfig.tag`, so each takes `latest`.
   ```sh
   pnpm -r build
   pnpm -r publish --access public --no-git-checks
   ```
   (`pnpm -r publish` publishes in dependency order and skips private packages.)
5. Verify every public package landed (a recursive publish in one burst has
   dropped packages twice); republish any that are missing with `--filter`:
   ```sh
   for f in $(git ls-files '*/package.json' | grep -vE '^(apps/|examples/)'); do
     n=$(node -e "const j=require('./$f'); if(!j.private&&j.name) console.log(j.name)");
     [ -z "$n" ] && continue
     npm view "$n@0.12.1" version >/dev/null 2>&1 || echo "MISSING $n"
   done
   pnpm -r --filter <missing-name> publish --access public --no-git-checks
   ```

## Pre-release template, `0.13.0-rc.1` (run in this order, from a clean `main`)

Every crate and every `@listen-fire/*` package is at `0.13.0-rc.1`. Set the version first, as in step 1 of "Promoting to a full release" below, and give each package `publishConfig.tag: "next"` (full releases carry none).
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
   git tag v0.13.0-rc.1 && git tag lf-v0.13.0-rc.1 && git tag docs-v0.13.0-rc.1
   git push origin v0.13.0-rc.1 lf-v0.13.0-rc.1 docs-v0.13.0-rc.1
   ```
3. Publish the crates, in dependency order (wait a minute between each for the index).
   ```sh
   cargo publish -p listen-fire-parser
   cargo publish -p listen-fire-checker
   cargo publish -p listen-fire-language
   cargo publish -p listen-fire-engine
   cargo publish -p listen-fire-module-wire
   cargo publish -p listen-fire
   cargo publish -p listen-fire-module-kit
   ```
   A pre-release version is never picked by `cargo install listen-fire` without `--version 0.13.0-rc.1`.
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
     npm view "$n@0.13.0-rc.1" version >/dev/null 2>&1 || echo "MISSING $n"
   done
   pnpm -r --filter <missing-name> publish --tag next --access public --no-git-checks
   ```

## Promoting a pre-release to a full release

1. Set the version (workspace `Cargo.toml`, the `version = "…"` of each path dependency in `crates/*/Cargo.toml`, every published `package.json`, `packages/movement-lang/language_version_value.ts`, the `cargo install … --version` line in `README.md`) to the plain version. Update `Cargo.lock` (`cargo update -w`) and `pnpm-lock.yaml` (`pnpm install`).
2. Remove `publishConfig.tag` from every package that has it (`git grep -n '"tag": "next"'`); left in, the package still publishes under `next`.
3. In `CHANGELOG.md`, add the version's heading with its date above the pre-releases' sections, which stay beneath it as history; drop the "preview" wording once it is no longer true, and say which pins the release no longer reads. Point the `[Unreleased]` link at the new tag.
4. Commit `release: <version>`, rebuild the wasm and commit it (step 0), then run the full release's steps with plain tags (`v<version>`, `lf-v<version>`, `docs-v<version>`) and publish npm without `--tag next`.

Note: a pre-release such as `0.13.0-rc.1` sorts above the released `0.12.0` and below `0.13.0`. Its docs stay under `/docs/next/` until the plain `docs-v0.13.0` tag publishes `/docs/0.13/` (and the language server's links switch with the crate version).

A release's language version is its own semver; its CHANGELOG entry says which pins it no longer reads. The platform adopts a language release by raising the versions of the `@listen-fire/*` packages it installs.
