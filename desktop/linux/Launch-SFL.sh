#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
unset NODE_OPTIONS || true
unset NODE_PATH || true

resolve_node() {
  if [ -n "${SFL_NODE_BINARY:-}" ]; then
    case "$SFL_NODE_BINARY" in
      /*) ;;
      *)
        echo "SFL_NODE_BINARY must name an existing absolute Node.js executable." >&2
        exit 1
        ;;
    esac
    if [ ! -f "$SFL_NODE_BINARY" ] || [ ! -x "$SFL_NODE_BINARY" ]; then
      echo "SFL_NODE_BINARY must name an existing absolute Node.js executable." >&2
      exit 1
    fi
    node="$SFL_NODE_BINARY"
  else
    node="$(command -v node || true)"
  fi
  if [ -z "${node:-}" ]; then
    echo "Node.js 22+ was not found. Install Node.js, set SFL_NODE_BINARY, or download the bundled-Node archive." >&2
    exit 1
  fi
  version="$("$node" --version)"
  major="${version#v}"
  major="${major%%.*}"
  case "$major" in
    ''|*[!0-9]*)
      echo "Node.js 22+ is required. Upgrade Node.js or download the bundled-Node archive." >&2
      exit 1
      ;;
  esac
  if [ "$major" -lt 22 ]; then
    echo "Node.js 22+ is required. Upgrade Node.js or download the bundled-Node archive." >&2
    exit 1
  fi
}

if [ "${1:-}" = "--resolve-only" ]; then
  resolve_node
  printf '%s\n' "$node"
  exit 0
fi
if [ "${1:-}" = "--mcp" ]; then
  shift
  resolve_node
  exec "$node" dist/index.js "$@"
fi
resolve_node
exec "$node" dist/index.js --local --quiet
