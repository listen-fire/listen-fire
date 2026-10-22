#!/bin/sh
# Installs the `lf` command from a GitHub release, keeping bin/ and share/
# together because lf finds its built-in modules at <prefix>/share/lf/modules.
#
#   LF_VERSION      release to install, with or without the lf-v prefix (default: newest)
#   LF_INSTALL_ROOT where releases unpack (default: $HOME/.lf)
#   LF_BIN_DIR      where the `lf` symlink goes (default: $HOME/.local/bin)
set -eu

REPO="listen-fire/listen-fire"

die() { echo "lf install: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin) os=apple-darwin ;;
  Linux) os=unknown-linux-musl ;;
  *) os= ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=aarch64 ;;
  x86_64) arch=x86_64 ;;
  *) arch= ;;
esac
[ -n "$os" ] && [ -n "$arch" ] || die "unsupported platform $(uname -s)/$(uname -m).
Prebuilt binaries exist for aarch64-apple-darwin, x86_64-apple-darwin,
x86_64-unknown-linux-musl and aarch64-unknown-linux-musl. Otherwise: cargo install listen-fire"
target="$arch-$os"

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
  fetch_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q "$1" -O "$2"; }
  fetch_stdout() { wget -qO- "$1"; }
else
  die "needs curl or wget"
fi

if command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
else
  die "needs shasum or sha256sum to verify the download"
fi

if [ -n "${LF_VERSION:-}" ]; then
  version="${LF_VERSION#lf-v}"
  version="${version#v}"
else
  # Every release so far is a pre-release, which GitHub's "latest" endpoint skips.
  releases="$(fetch_stdout "https://api.github.com/repos/$REPO/releases?per_page=20")" \
    || die "could not list releases (network down or GitHub rate limit); set LF_VERSION to skip the lookup"
  version="$(printf '%s\n' "$releases" \
    | sed -n 's/.*"tag_name": *"lf-v\([^"]*\)".*/\1/p' | head -n 1)"
  [ -n "$version" ] || die "no lf-v* release found (GitHub may have rate-limited the request); set LF_VERSION"
fi

name="lf-v$version-$target"
base="https://github.com/$REPO/releases/download/lf-v$version"
root="${LF_INSTALL_ROOT:-$HOME/.lf}"
bindir="${LF_BIN_DIR:-$HOME/.local/bin}"
dest="$root/$version"
link="$bindir/lf"

if [ -e "$link" ] && [ ! -L "$link" ]; then
  die "$link exists and is not a symlink; move it aside and re-run"
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

echo "Downloading $name.tar.gz"
fetch "$base/$name.tar.gz" "$tmp/$name.tar.gz" || die "download failed: $base/$name.tar.gz"
fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || die "download failed: $base/SHA256SUMS"

expected="$(awk -v f="$name.tar.gz" '$2 == f { print $1 }' "$tmp/SHA256SUMS")"
[ -n "$expected" ] || die "SHA256SUMS has no entry for $name.tar.gz"
actual="$(sha256 "$tmp/$name.tar.gz")"
[ "$expected" = "$actual" ] || die "checksum mismatch for $name.tar.gz (expected $expected, got $actual); nothing installed"

mkdir -p "$dest" "$bindir"
tar -xzf "$tmp/$name.tar.gz" -C "$dest" --strip-components=1
ln -sfn "$dest/bin/lf" "$link"

echo "Installed lf $version to $dest"
echo "Linked $link -> $dest/bin/lf"
case ":$PATH:" in
  *":$bindir:"*) ;;
  *) echo "Add it to your PATH:  export PATH=\"$bindir:\$PATH\"" ;;
esac
echo "Node 22 is needed only once a system is connected."
