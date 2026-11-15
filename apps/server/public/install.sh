#!/bin/sh
# catcher CLI installer for macOS and Linux.
#
#   curl -fsSL https://catcher.bang9.dev/install.sh | sh
#
# Downloads the catcher binary for this machine from GitHub Releases (github.com/bang9/catcher), checks its SHA-256
# against the release's SHA256SUMS and installs it to ~/.local/bin (or $CATCHER_INSTALL_DIR). No sudo.
#
#   CATCHER_VERSION=0.2.0       install that version instead of the latest
#   CATCHER_INSTALL_DIR=<dir>   install there instead of ~/.local/bin
#
# Windows: npm i -g catcher-cli, or download catcher-x86_64-pc-windows-msvc.exe from the release page.
# Everything below runs only after the whole script has downloaded (see the last line).

set -eu

REPO='bang9/catcher'

say() {
  printf '%s\n' "$*"
}

fail() {
  printf 'catcher install: %s\n' "$*" >&2
  exit 1
}

fetch() {
  # fetch <url> <file>
  if command -v curl >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    # GNU wget can refuse non-https redirects; BusyBox wget (Alpine) has no such flag
    if wget --help 2>&1 | grep -q -- '--https-only'; then
      wget --https-only -q -O "$2" "$1"
    else
      wget -q -O "$2" "$1"
    fi
  else
    fail 'needs curl or wget'
  fi
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    fail 'needs sha256sum or shasum to verify the download; install one and run this again'
  fi
}

detect_target() {
  os=$(uname -s)
  arch=$(uname -m)
  case "$os" in
    Darwin)
      # a shell running under Rosetta reports x86_64 on Apple silicon; install the native build
      if [ "$arch" = 'x86_64' ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || true)" = '1' ]; then
        arch='arm64'
      fi
      case "$arch" in
        arm64 | aarch64) echo 'aarch64-apple-darwin' ;;
        x86_64 | amd64) echo 'x86_64-apple-darwin' ;;
        *) fail "no build for macOS on $arch" ;;
      esac
      ;;
    Linux)
      # static musl builds: they run on any Linux distribution, glibc or musl
      case "$arch" in
        x86_64 | amd64) echo 'x86_64-unknown-linux-musl' ;;
        aarch64 | arm64) echo 'aarch64-unknown-linux-musl' ;;
        *) fail "no build for Linux on $arch" ;;
      esac
      ;;
    MINGW* | MSYS* | CYGWIN* | Windows_NT)
      fail 'on Windows, run: npm i -g catcher-cli (or download the .exe from https://github.com/bang9/catcher/releases)'
      ;;
    *) fail "no build for $os" ;;
  esac
}

latest_version() {
  # newest cli-v* release; other release tags in the repository are skipped
  if ! fetch "https://api.github.com/repos/$REPO/releases?per_page=50" "$1"; then
    fail 'could not ask GitHub for the latest version (rate limited?); set CATCHER_VERSION=<x.y.z> or use npm i -g catcher-cli'
  fi
  # releases come newest first; split on commas so minified and pretty JSON read the same; skip pre-releases (x.y.z-…)
  tag=$(tr ',' '\n' <"$1" | sed -n 's/.*"tag_name": *"cli-v\([0-9]*\.[0-9]*\.[0-9]*\)".*/\1/p' | head -n 1)
  [ -n "$tag" ] || fail 'could not find a catcher CLI release; set CATCHER_VERSION and try again'
  echo "$tag"
}

main() {
  target=$(detect_target)
  dir="${CATCHER_INSTALL_DIR:-$HOME/.local/bin}"
  tmp=$(mktemp -d 2>/dev/null || mktemp -d -t catcher)
  trap 'rm -rf "$tmp"' EXIT
  trap 'exit 1' INT TERM

  version="${CATCHER_VERSION:-}"
  version="${version#v}"
  if [ -z "$version" ]; then
    version=$(latest_version "$tmp/releases.json")
  fi
  case "$version" in
    *[!0-9A-Za-z.+-]*) fail "bad version: $version" ;;
  esac

  base="https://github.com/$REPO/releases/download/cli-v$version"
  asset="catcher-$target"
  say "Installing catcher $version ($target)"

  fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || fail "no release cli-v$version (or no SHA256SUMS in it)"
  expected=$(awk -v name="$asset" '$2 == name || $2 == "*" name { print $1; exit }' "$tmp/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS of cli-v$version has no entry for $asset"

  fetch "$base/$asset" "$tmp/catcher" || fail "download failed: $base/$asset"
  actual=$(sha256 "$tmp/catcher")
  [ "$actual" = "$expected" ] || fail "checksum mismatch for $asset (expected $expected, got $actual); nothing was installed"

  mkdir -p "$dir"
  chmod 755 "$tmp/catcher"
  mv -f "$tmp/catcher" "$dir/catcher"
  say "Installed $dir/catcher"
  "$dir/catcher" --version || true

  case ":${PATH:-}:" in
    *":$dir:"*) ;;
    *)
      say ''
      say "$dir is not on your PATH. Use the full path, or add this to your shell profile:"
      say "  export PATH=\"$dir:\$PATH\""
      ;;
  esac
  say ''
  say 'Next: catcher register --name <name>   (or tell your agent to read https://catcher.bang9.dev/agent.md)'
}

main "$@"
