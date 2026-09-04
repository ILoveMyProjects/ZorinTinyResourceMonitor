#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUT="$ROOT/dist"

if ! command -v gnome-extensions >/dev/null 2>&1; then
    echo "ERROR: gnome-extensions is required to build the GNOME extension bundle." >&2
    exit 1
fi

mkdir -p "$OUT"
gnome-extensions pack --force --out-dir="$OUT" "$ROOT"
echo "Bundle created in: $OUT"
