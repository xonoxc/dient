#!/bin/sh
# dient installer — downloads the release binary for this machine and installs
# it as `dient`.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/xonoxc/dient/main/install.sh | sh
#   curl -fsSL ... | sh -s -- --version v0.1.0 --dir ~/bin
#
# Environment:
#   DIENT_VERSION      Release tag to install (default: latest)
#   DIENT_INSTALL_DIR  Directory to install into (default: ~/.local/bin, or
#                      /usr/local/bin when run as root)
#   DIENT_REPO         owner/repo to download from (default: xonoxc/dient)
#
# The script leans on the same asset-name contract as the in-app updater
# (`src/update/check.ts`) and `.github/workflows/release.yml`: changing the
# `dient-<os>-<arch>` names means changing all three.
set -eu

REPO="${DIENT_REPO:-xonoxc/dient}"
VERSION="${DIENT_VERSION:-}"
INSTALL_DIR="${DIENT_INSTALL_DIR:-}"
BINARY="dient"

log() {
  printf '%s\n' "$*" >&2
}

die() {
  log "error: $*"
  exit 1
}

usage() {
  cat <<EOF
Install dient (the terminal database client).

Usage:
  install.sh [options]

Options:
  -v, --version <tag>  Release tag to install (default: latest)
  -d, --dir <path>     Directory to install into
  -h, --help           Show this help

Environment:
  DIENT_VERSION        Same as --version
  DIENT_INSTALL_DIR    Same as --dir
  DIENT_REPO           GitHub owner/repo (default: xonoxc/dient)

Examples:
  curl -fsSL https://raw.githubusercontent.com/xonoxc/dient/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/xonoxc/dient/main/install.sh | sh -s -- --version v0.1.0
  DIENT_INSTALL_DIR=/usr/local/bin ./install.sh
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -v | --version)
      [ $# -ge 2 ] || die "$1 needs a value"
      VERSION="$2"
      shift 2
      ;;
    -d | --dir)
      [ $# -ge 2 ] || die "$1 needs a value"
      INSTALL_DIR="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1 (try --help)"
      ;;
  esac
done

# --- platform -------------------------------------------------------------

os="$(uname -s)"
case "$os" in
  Linux | GNU/Linux) os="linux" ;;
  Darwin) os="darwin" ;;
  *)
    die "unsupported operating system: $os (dient ships Linux and macOS binaries)"
    ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch="x64" ;;
  arm64 | aarch64) arch="arm64" ;;
  *)
    die "unsupported architecture: $arch (dient ships x64 and arm64 binaries)"
    ;;
esac

# Under Rosetta 2, uname reports x86_64 even on Apple silicon. Prefer the
# native arm64 binary when the CPU supports it.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || true)" = "1" ]; then
    arch="arm64"
  fi
fi

asset="dient-${os}-${arch}"

# --- install location -----------------------------------------------------

if [ -z "$INSTALL_DIR" ]; then
  if [ "$(id -u)" -eq 0 ]; then
    INSTALL_DIR="/usr/local/bin"
  else
    [ -n "${HOME:-}" ] || die "HOME is not set; pass --dir to choose an install directory"
    INSTALL_DIR="$HOME/.local/bin"
  fi
fi

# --- download URL ---------------------------------------------------------

if [ -n "$VERSION" ] && [ "$VERSION" != "latest" ]; then
  case "$VERSION" in
    v*) tag="$VERSION" ;;
    *) tag="v$VERSION" ;;
  esac
  url="https://github.com/${REPO}/releases/download/${tag}/${asset}"
else
  url="https://github.com/${REPO}/releases/latest/download/${asset}"
fi

# --- download -------------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  download() {
    curl -fsSL --retry 3 --retry-delay 2 -o "$2" "$1"
  }
elif command -v wget >/dev/null 2>&1; then
  download() {
    wget -q -O "$2" "$1"
  }
else
  die "curl or wget is required to download dient"
fi

mkdir -p "$INSTALL_DIR" 2>/dev/null || die "could not create $INSTALL_DIR"
[ -w "$INSTALL_DIR" ] || die "cannot write to $INSTALL_DIR (pass --dir to choose another location)"

# Stage in the install directory so the final `mv` is atomic and works even
# when /tmp is a different filesystem.
tmp="${INSTALL_DIR}/.${BINARY}.tmp.$$"
cleanup() {
  [ -z "$tmp" ] || rm -f "$tmp"
}
trap cleanup EXIT HUP INT TERM

log "Downloading ${asset}..."
if ! download "$url" "$tmp"; then
  die "could not download ${asset}; check that the release exists and publishes a binary for ${os}-${arch}:
  $url"
fi
[ -s "$tmp" ] || die "downloaded file is empty: $url"

chmod 755 "$tmp"
mv -f "$tmp" "${INSTALL_DIR}/${BINARY}" || die "could not install to ${INSTALL_DIR}/${BINARY} (is dient running?)"
tmp=""

# --- done -----------------------------------------------------------------

log ""
log "Installed ${BINARY} to ${INSTALL_DIR}/${BINARY}"

case ":${PATH:-}:" in
  *":${INSTALL_DIR}:"*) ;;
  *)
    log ""
    log "note: ${INSTALL_DIR} is not on your PATH. Add it by appending this line"
    log "to your shell profile (~/.bashrc, ~/.zshrc, or similar):"
    log ""
    log "  export PATH=\"${INSTALL_DIR}:\$PATH\""
    ;;
esac

log ""
log "Run 'dient' to get started."
