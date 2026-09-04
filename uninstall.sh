#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
METADATA="$ROOT/metadata.json"
UUID="$(sed -n 's/^[[:space:]]*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$METADATA" | head -n1)"

if [[ -z "$UUID" ]]; then
    echo "ERROR: Cannot read uuid from metadata.json" >&2
    exit 1
fi

if [[ ! "$UUID" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]]; then
    echo "ERROR: Unsafe or invalid extension UUID: $UUID" >&2
    exit 1
fi

if command -v gnome-extensions >/dev/null 2>&1; then
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
fi

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
TARGET="$DATA_HOME/gnome-shell/extensions/$UUID"
rm -rf -- "$TARGET"

echo "Removed: $TARGET"
echo "If the panel item is still visible, log out and back in (Wayland) or restart GNOME Shell on X11."
