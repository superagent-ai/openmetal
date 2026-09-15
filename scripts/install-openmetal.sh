#!/bin/sh
set -eu

REPOSITORY="${OPENMETAL_REPOSITORY:-superagent-ai/openmetal}"
INSTALL_DIR="${OPENMETAL_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${OPENMETAL_VERSION:-latest}"

case "$(uname -s)" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "openmetal: unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  x86_64|amd64) arch="x64" ;;
  arm64|aarch64) arch="arm64" ;;
  *) echo "openmetal: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

libc=""
if [ "$os" = "linux" ]; then
  if command -v ldd >/dev/null 2>&1 && ldd --version 2>&1 | awk 'BEGIN{IGNORECASE=1} /musl/{found=1} END{exit !found}'; then
    libc="-musl"
  fi
fi

asset="openmetal-${os}-${arch}${libc}.tar.gz"
if [ -n "${OPENMETAL_RELEASE_BASE_URL:-}" ]; then
  base_url="${OPENMETAL_RELEASE_BASE_URL%/}"
elif [ "$VERSION" = "latest" ]; then
  base_url="https://github.com/${REPOSITORY}/releases/latest/download"
else
  case "$VERSION" in cli-v*) tag="$VERSION" ;; *) tag="cli-v$VERSION" ;; esac
  base_url="https://github.com/${REPOSITORY}/releases/download/${tag}"
fi

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT INT TERM

echo "Downloading ${asset}..."
curl -fsSL "${base_url}/${asset}" -o "${tmp_dir}/${asset}"
curl -fsSL "${base_url}/SHA256SUMS" -o "${tmp_dir}/SHA256SUMS"

expected="$(awk -v asset="$asset" '$2 == asset { print $1 }' "${tmp_dir}/SHA256SUMS")"
if [ -z "$expected" ]; then
  echo "openmetal: checksum for ${asset} was not found" >&2
  exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmp_dir}/${asset}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${tmp_dir}/${asset}" | awk '{print $1}')"
else
  echo "openmetal: sha256sum or shasum is required" >&2
  exit 1
fi
if [ "$actual" != "$expected" ]; then
  echo "openmetal: checksum verification failed" >&2
  exit 1
fi

tar -xzf "${tmp_dir}/${asset}" -C "$tmp_dir"
mkdir -p "$INSTALL_DIR"
install -m 0755 "${tmp_dir}/openmetal" "${INSTALL_DIR}/openmetal"

echo "Installed openmetal to ${INSTALL_DIR}/openmetal"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Add ${INSTALL_DIR} to PATH to run openmetal." ;;
esac
