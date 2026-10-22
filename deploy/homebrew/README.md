# Homebrew tap (drafted, not yet live)

`lf.rb` is the formula for a tap named `listen-fire/tap`, pinned to rc.4.

Create the tap once:

1. Create a public repository `listen-fire/homebrew-tap` (the `homebrew-` prefix is what makes `brew tap listen-fire/tap` work).
2. Copy `lf.rb` to `Formula/lf.rb` in it and push.
3. Users then run `brew install listen-fire/tap/lf`.

The release workflow does not bump the formula yet. The job to add to `lf-release.yml`:

- Trigger: an `lf-v*` tag, `needs:` the job that uploads the release assets.
- Download `SHA256SUMS` from the new release and read the four tarball hashes.
- Template `lf.rb`: the version in the URLs and the four `sha256` lines.
- Check out `listen-fire/homebrew-tap` with a token that can push to it (a repository secret, e.g. `TAP_TOKEN`).
- Commit `Formula/lf.rb` and push to its default branch.
