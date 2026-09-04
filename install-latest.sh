#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_REPO="ILoveMyProjects/ZorinTinyResourceMonitor"
readonly EXPECTED_UUID="tiny-resource-monitor@local"
readonly MANIFEST_URL="https://raw.githubusercontent.com/${PROJECT_REPO}/master/update.json"
readonly RELEASE_URL_PREFIX="https://github.com/${PROJECT_REPO}/releases/download/"

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

need_cmd curl
need_cmd python3
need_cmd sha256sum
need_cmd gnome-shell
need_cmd gnome-extensions
need_cmd grep
need_cmd mktemp

SHELL_VERSION="$(gnome-shell --version | awk '{print $3}')"
[[ -n "$SHELL_VERSION" ]] || fail "Could not determine GNOME Shell version."
SHELL_MAJOR="${SHELL_VERSION%%.*}"

TMPDIR_PATH="$(mktemp -d)"
trap 'rm -rf -- "$TMPDIR_PATH"' EXIT INT TERM

MANIFEST_FILE="$TMPDIR_PATH/update.json"
ZIP_FILE="$TMPDIR_PATH/extension.zip"
VALIDATED_DIR="$TMPDIR_PATH/validated"
mkdir -p "$VALIDATED_DIR"

printf 'Tiny Resource Monitor installer\n'
printf 'Repository: https://github.com/%s\n' "$PROJECT_REPO"
printf 'Detected GNOME Shell: %s\n\n' "$SHELL_VERSION"
printf 'Fetching release manifest...\n'

curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    "$MANIFEST_URL" \
    --output "$MANIFEST_FILE"

python3 - "$MANIFEST_FILE" "$VALIDATED_DIR" "$EXPECTED_UUID" "$RELEASE_URL_PREFIX" <<'PY'
import json
import pathlib
import re
import sys
from urllib.parse import urlparse

manifest_path = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
expected_uuid = sys.argv[3]
release_prefix = sys.argv[4]

try:
    data = json.loads(manifest_path.read_text(encoding='utf-8'))
except Exception as exc:
    raise SystemExit(f'Invalid update manifest JSON: {exc}')

if not isinstance(data, dict):
    raise SystemExit('Update manifest must be a JSON object')
if data.get('schema') != 1:
    raise SystemExit(f"Unsupported update manifest schema: {data.get('schema')!r}")
if data.get('uuid') != expected_uuid:
    raise SystemExit(f"Unexpected extension UUID: {data.get('uuid')!r}")

version = data.get('version')
if not isinstance(version, int) or isinstance(version, bool) or version < 1:
    raise SystemExit('Manifest version must be a positive integer')

version_name = data.get('version_name')
if not isinstance(version_name, str) or not version_name.strip() or len(version_name) > 64:
    raise SystemExit('Manifest version_name is invalid')

shell_versions = data.get('shell_versions')
if not isinstance(shell_versions, list) or not shell_versions or not all(isinstance(v, str) for v in shell_versions):
    raise SystemExit('Manifest shell_versions is invalid')

download_url = data.get('download_url')
if not isinstance(download_url, str) or not download_url.startswith(release_prefix):
    raise SystemExit('Manifest download_url is outside the expected GitHub Releases location')
parsed = urlparse(download_url)
if parsed.scheme != 'https' or parsed.hostname != 'github.com' or parsed.username or parsed.password:
    raise SystemExit('Manifest download_url must be a plain HTTPS github.com URL')

sha256 = data.get('sha256')
if not isinstance(sha256, str) or not re.fullmatch(r'[0-9a-fA-F]{64}', sha256):
    raise SystemExit('Manifest sha256 must contain exactly 64 hexadecimal characters')

values = {
    'version': str(version),
    'version_name': version_name.strip(),
    'download_url': download_url,
    'sha256': sha256.lower(),
    'shell_versions': '\n'.join(shell_versions),
}
for name, value in values.items():
    (out / name).write_text(value, encoding='utf-8')
PY

VERSION="$(<"$VALIDATED_DIR/version")"
VERSION_NAME="$(<"$VALIDATED_DIR/version_name")"
DOWNLOAD_URL="$(<"$VALIDATED_DIR/download_url")"
EXPECTED_SHA256="$(<"$VALIDATED_DIR/sha256")"

if ! grep -Fxq -- "$SHELL_MAJOR" "$VALIDATED_DIR/shell_versions"; then
    fail "Latest release $VERSION_NAME does not declare support for GNOME Shell $SHELL_MAJOR."
fi

printf 'Latest release: %s (version %s)\n' "$VERSION_NAME" "$VERSION"
printf 'Downloading verified release asset...\n'

curl \
    --fail \
    --silent \
    --show-error \
    --location \
    --proto '=https' \
    --proto-redir '=https' \
    --tlsv1.2 \
    "$DOWNLOAD_URL" \
    --output "$ZIP_FILE"

ACTUAL_SHA256="$(sha256sum "$ZIP_FILE" | awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
    fail "SHA-256 verification failed. Expected $EXPECTED_SHA256, got $ACTUAL_SHA256. Nothing was installed."
fi
printf 'SHA-256: OK\n'

python3 - "$ZIP_FILE" "$EXPECTED_UUID" "$VERSION" "$VERSION_NAME" "$SHELL_MAJOR" <<'PY'
import json
import pathlib
import stat
import sys
import zipfile

zip_path = pathlib.Path(sys.argv[1])
expected_uuid = sys.argv[2]
expected_version = int(sys.argv[3])
expected_version_name = sys.argv[4]
expected_shell_major = sys.argv[5]

try:
    with zipfile.ZipFile(zip_path) as zf:
        bad_crc = zf.testzip()
        if bad_crc is not None:
            raise SystemExit(f'ZIP CRC check failed for {bad_crc!r}')

        names = zf.namelist()
        if 'metadata.json' not in names:
            raise SystemExit('Release ZIP does not contain metadata.json at its root')

        for info in zf.infolist():
            name = info.filename.replace('\\', '/')
            p = pathlib.PurePosixPath(name)
            if name.startswith('/') or '..' in p.parts:
                raise SystemExit(f'Unsafe path in release ZIP: {info.filename!r}')
            mode = (info.external_attr >> 16) & 0xFFFF
            if mode and stat.S_ISLNK(mode):
                raise SystemExit(f'Symbolic links are not allowed in release ZIP: {info.filename!r}')

        metadata = json.loads(zf.read('metadata.json').decode('utf-8'))
except zipfile.BadZipFile as exc:
    raise SystemExit(f'Invalid release ZIP: {exc}')
except (UnicodeDecodeError, json.JSONDecodeError) as exc:
    raise SystemExit(f'Invalid metadata.json in release ZIP: {exc}')

if metadata.get('uuid') != expected_uuid:
    raise SystemExit(f"ZIP UUID mismatch: {metadata.get('uuid')!r}")
if metadata.get('version') != expected_version:
    raise SystemExit(f"ZIP version mismatch: {metadata.get('version')!r}")
if metadata.get('version-name') != expected_version_name:
    raise SystemExit(f"ZIP version-name mismatch: {metadata.get('version-name')!r}")

shell_versions = metadata.get('shell-version')
if not isinstance(shell_versions, list) or not all(isinstance(v, str) for v in shell_versions):
    raise SystemExit('ZIP metadata shell-version is invalid')
if expected_shell_major not in shell_versions:
    raise SystemExit(f'ZIP metadata does not declare GNOME Shell {expected_shell_major} compatibility')
PY

printf 'Package metadata: OK\n'
printf 'Installing %s...\n' "$VERSION_NAME"
gnome-extensions install --force "$ZIP_FILE"
printf 'Installation command completed successfully.\n\n'

if gnome-extensions list --user 2>/dev/null | grep -Fxq "$EXPECTED_UUID"; then
    if gnome-extensions enable "$EXPECTED_UUID" >/dev/null 2>&1; then
        printf 'Extension enabled: %s\n' "$EXPECTED_UUID"
    else
        printf 'The extension is installed, but GNOME Shell could not enable it in this session.\n'
        printf 'Log out and log back in, then run:\n  gnome-extensions enable %q\n' "$EXPECTED_UUID"
    fi
else
    printf 'The extension is installed. GNOME Shell has not loaded the new extension yet.\n'
    printf 'On Wayland, log out and log back in, then run:\n  gnome-extensions enable %q\n' "$EXPECTED_UUID"
fi
