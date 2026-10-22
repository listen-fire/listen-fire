# The human-readable reference for the formula live at listen-fire/homebrew-tap
# (Formula/lf.rb). The lf-release workflow does not copy this file: on every
# lf-v* tag it renders the live formula from the same shape, so keep the two in step.
# Pinned to rc.4 here; see README.md.
class Lf < Formula
  desc "Listen-Fire: the movement language and its local runner"
  homepage "https://github.com/listen-fire/listen-fire"
  version "0.12.0-rc.4"
  license "Apache-2.0"

  # The built-in modules are TypeScript and need Node once a system is connected.
  depends_on "node"

  on_macos do
    on_arm do
      url "https://github.com/listen-fire/listen-fire/releases/download/lf-v0.12.0-rc.4/lf-v0.12.0-rc.4-aarch64-apple-darwin.tar.gz"
      sha256 "dc36ca3666686a05bb7e7a2dab391e7f11622a5102f1d410ce5c4596f98aa419"
    end
    on_intel do
      url "https://github.com/listen-fire/listen-fire/releases/download/lf-v0.12.0-rc.4/lf-v0.12.0-rc.4-x86_64-apple-darwin.tar.gz"
      sha256 "f6d12f9f9bf6d838b5bdb29cccc9a3c66a9b161a99f9da93f2bf03b0284fb9cf"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/listen-fire/listen-fire/releases/download/lf-v0.12.0-rc.4/lf-v0.12.0-rc.4-aarch64-unknown-linux-musl.tar.gz"
      sha256 "4e5d3d4225caa4ff29ffde48f7fa330e3e6a80aa05bf6ad722a50a8128d35c0d"
    end
    on_intel do
      url "https://github.com/listen-fire/listen-fire/releases/download/lf-v0.12.0-rc.4/lf-v0.12.0-rc.4-x86_64-unknown-linux-musl.tar.gz"
      sha256 "3e09c0598230fb527da0a0103611c11253bb60810f26aa297f47a8aa050ef37b"
    end
  end

  def install
    # bin/ and share/ stay together: lf finds its modules at <prefix>/share/lf/modules.
    prefix.install Dir["*"]
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/lf --version")
  end
end
