#!/bin/sh
# Beckon helper installer. Served at https://<server>/install.sh
#
#   curl -fsSL https://beckoncli.com/install.sh | sh
#
# Detects your OS and CPU, downloads the matching release from GitHub, verifies its SHA-256
# checksum (and the checksum file's cosign signature when cosign is installed), and installs
# `beckon` to ~/.local/bin without sudo, with `beckon-chain` (runs prompt files as a chain) next to it when
# the release has it. Read it before you run it.
#
# Environment (all optional):
#   BECKON_VERSION        release tag to install, e.g. v0.7.0 (default: latest)
#   BECKON_INSTALL_DIR    where to put the binary (default: $HOME/.local/bin)
#   BECKON_REQUIRE_COSIGN set to 1 to fail if cosign is missing instead of skipping the signature check
#   BECKON_RELEASE_BASE   base URL of the releases (default: https://github.com/@@REPO@@/releases)

set -eu

REPO="@@REPO@@"
BASE="${BECKON_RELEASE_BASE:-https://github.com/${REPO}/releases}"
VERSION="${BECKON_VERSION:-latest}"
DEST="${BECKON_INSTALL_DIR:-${HOME:?HOME is not set}/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'beckon install: %s\n' "$*" >&2; exit 1; }

# ---- tools ----
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 2 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q -O "$2" "$1"; }
else
  die "curl or wget is required"
fi
if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d ' ' -f 1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d ' ' -f 1; }
else
  die "sha256sum or shasum is required to verify the download"
fi
command -v tar >/dev/null 2>&1 || die "tar is required"

# ---- platform ----
case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) die "unsupported OS $(uname -s): Beckon supports macOS and Linux" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=amd64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) die "unsupported CPU $(uname -m): Beckon supports amd64 and arm64" ;;
esac

if [ "$VERSION" = "latest" ]; then
  URL="${BASE}/latest/download"
else
  URL="${BASE}/download/${VERSION}"
fi

TMP="$(mktemp -d 2>/dev/null || mktemp -d -t beckon)"
trap 'rm -rf "$TMP"' EXIT INT HUP TERM

# ---- checksums, and their signature ----
say "Installing beckon for ${OS}/${ARCH} (${VERSION})"
fetch "${URL}/checksums.txt" "${TMP}/checksums.txt" || die "could not download checksums.txt from ${URL}"

if command -v cosign >/dev/null 2>&1; then
  fetch "${URL}/checksums.txt.sig" "${TMP}/checksums.txt.sig" || die "could not download checksums.txt.sig"
  fetch "${URL}/checksums.txt.pem" "${TMP}/checksums.txt.pem" || die "could not download checksums.txt.pem"
  cosign verify-blob \
    --certificate-identity-regexp "^https://github\\.com/${REPO}/\\.github/workflows/release\\.yml@refs/tags/v.+" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
    --certificate "${TMP}/checksums.txt.pem" \
    --signature "${TMP}/checksums.txt.sig" \
    "${TMP}/checksums.txt" >/dev/null 2>&1 \
    || die "the signature on checksums.txt does not verify; refusing to install"
  say "Signature verified (cosign)."
elif [ "${BECKON_REQUIRE_COSIGN:-}" = "1" ]; then
  die "cosign not found and BECKON_REQUIRE_COSIGN=1"
else
  say "cosign not found: skipping the signature check (the checksum is still verified)."
fi

# ---- the archive ----
LINE="$(grep "_${OS}_${ARCH}\\.tar\\.gz\$" "${TMP}/checksums.txt" | head -n 1 || true)"
[ -n "$LINE" ] || die "no build for ${OS}/${ARCH} in this release"
WANT="${LINE%% *}"
ASSET="${LINE##* }"
ASSET="${ASSET#\*}"
case "$ASSET" in
  *[!A-Za-z0-9._-]* | "") die "unexpected file name in checksums.txt" ;;
esac

fetch "${URL}/${ASSET}" "${TMP}/${ASSET}" || die "could not download ${ASSET}"
GOT="$(sha256 "${TMP}/${ASSET}")"
[ "$GOT" = "$WANT" ] || die "checksum mismatch for ${ASSET} (expected ${WANT}, got ${GOT}); nothing was installed"
say "Checksum verified."

mkdir -p "${TMP}/x"
tar -xzf "${TMP}/${ASSET}" -C "${TMP}/x" beckon 2>/dev/null || die "the archive does not contain a beckon binary"
[ -f "${TMP}/x/beckon" ] || die "the archive does not contain a beckon binary"
# The chain runner (devbox/chain). Releases before it was added have no beckon-chain: skip it.
CHAIN=0
if tar -xzf "${TMP}/${ASSET}" -C "${TMP}/x" beckon-chain 2>/dev/null && [ -f "${TMP}/x/beckon-chain" ]; then
  CHAIN=1
fi

# ---- install ----
mkdir -p "$DEST" || die "cannot create ${DEST}"
cp "${TMP}/x/beckon" "${DEST}/beckon.new" && chmod 755 "${DEST}/beckon.new" && mv -f "${DEST}/beckon.new" "${DEST}/beckon" \
  || die "cannot write to ${DEST}"
say "Installed ${DEST}/beckon"
if [ "$CHAIN" = 1 ]; then
  cp "${TMP}/x/beckon-chain" "${DEST}/beckon-chain.new" && chmod 755 "${DEST}/beckon-chain.new" \
    && mv -f "${DEST}/beckon-chain.new" "${DEST}/beckon-chain" || die "cannot write to ${DEST}"
  say "Installed ${DEST}/beckon-chain"
fi

case ":${PATH}:" in
  *":${DEST}:"*) ;;
  *)
    say ""
    say "${DEST} is not on your PATH. Add it, for example:"
    say "  echo 'export PATH=\"${DEST}:\$PATH\"' >> ~/.profile   # then open a new terminal"
    ;;
esac

say ""
say "Next: beckon login     # sign this machine in"
say "      beckon setup     # connect your coding agents"

# A respond rule decides what a phone can type, so the user adds the chain's on purpose. Say how, unless it's there.
RULES="${BECKON_CONFIG_DIR:-${XDG_CONFIG_HOME:-${HOME}/.config}/beckon}/detectors.toml"
if [ "$CHAIN" = 1 ] && ! grep -Eqs '^[[:space:]]*app[[:space:]]*=[[:space:]]*"beckon-chain"' "$RULES"; then
  case "$RULES" in
    "${HOME}"/*) RULES="~${RULES#"${HOME}"}" ;;
  esac
  say ""
  say "To answer a chain's questions with buttons on your phone, add its rule once, after beckon login:"
  say "  beckon-chain --rule >> ${RULES}"
fi
