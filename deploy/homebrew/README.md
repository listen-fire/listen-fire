# Homebrew tap

The tap is live: `brew install listen-fire/tap/listen-fire`.

`listen-fire.rb` is the reference shape of the formula. The live one is
`Formula/listen-fire.rb` in `listen-fire/homebrew-tap`, and the `homebrew` job in
`.github/workflows/lf-release.yml` renders it, not this file.

On every `lf-v*` tag (pre-releases included) that job waits for the release, reads
the four tarball hashes from its `SHA256SUMS`, writes the formula with that
version and those hashes, and pushes it to the tap. It changes nothing when the
formula is unchanged.

To enable it, set the repository secret `HOMEBREW_TAP_TOKEN` on
`listen-fire/listen-fire`: a fine-grained token with contents read/write on
`listen-fire/homebrew-tap`. Without it the job prints a notice and skips.

If you change the formula's shape, change both this file and the job's template.
