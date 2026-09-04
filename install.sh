#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
METADATA="$ROOT/metadata.json"
UUID="$(sed -n 's/^[[:space:]]*"uuid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$METADATA" | head -n1)"

if [[ -z "$UUID" ]]; then
    echo "ERROR: Cannot read uuid from metadata.json" >&2
    exit 1
fi

# Prevent metadata tampering from turning rm -rf into an unsafe path.
if [[ ! "$UUID" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+$ ]]; then
    echo "ERROR: Unsafe or invalid extension UUID: $UUID" >&2
    exit 1
fi

if ! command -v gnome-shell >/dev/null 2>&1; then
    echo "ERROR: gnome-shell is not installed." >&2
    exit 1
fi

if ! command -v gnome-extensions >/dev/null 2>&1; then
    echo "ERROR: gnome-extensions is not available." >&2
    exit 1
fi

if ! command -v glib-compile-schemas >/dev/null 2>&1; then
    echo "ERROR: glib-compile-schemas is required for extension preferences." >&2
    exit 1
fi

SHELL_VERSION="$(gnome-shell --version | awk '{print $3}')"
SHELL_MAJOR="${SHELL_VERSION%%.*}"

if [[ "$SHELL_MAJOR" != "46" ]]; then
    echo "ERROR: This release targets GNOME Shell 46 only; detected: $SHELL_VERSION" >&2
    exit 1
fi

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
TARGET="$DATA_HOME/gnome-shell/extensions/$UUID"

mkdir -p "$(dirname -- "$TARGET")"
rm -rf -- "$TARGET"
mkdir -p -- "$TARGET/schemas"
install -m 0644 "$ROOT/extension.js" "$TARGET/extension.js"
install -m 0644 "$ROOT/prefs.js" "$TARGET/prefs.js"
install -m 0644 "$ROOT/metadata.json" "$TARGET/metadata.json"
install -m 0644 "$ROOT/schemas/org.gnome.shell.extensions.tiny-resource-monitor.gschema.xml" \
    "$TARGET/schemas/org.gnome.shell.extensions.tiny-resource-monitor.gschema.xml"
glib-compile-schemas "$TARGET/schemas"

echo "Installed: $TARGET"
echo

if gnome-extensions list --user 2>/dev/null | grep -Fxq "$UUID"; then
    if gnome-extensions enable "$UUID"; then
        echo "Enabled: $UUID"
    else
        echo "Installed, but GNOME Shell could not enable it in the current session."
    fi
else
    echo "GNOME Shell has not loaded the newly installed extension yet."
    echo "On Wayland: log out and log back in, then run:"
    echo "  gnome-extensions enable '$UUID'"
    echo "On X11: Alt+F2, type r, press Enter, then run the same enable command."
fi
