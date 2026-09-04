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
need_cmd gsettings
need_cmd grep
need_cmd mktemp

update_shell_extension_list() {
    local key="$1"
    local action="$2"
    local current new_value

    current="$(gsettings get org.gnome.shell "$key")" || return 1
    new_value="$(python3 - "$current" "$EXPECTED_UUID" "$action" <<'PYGSET'
import ast
import sys

raw = sys.argv[1].strip()
uuid = sys.argv[2]
action = sys.argv[3]
if raw.startswith('@as '):
    raw = raw[4:].strip()
try:
    values = ast.literal_eval(raw)
except Exception as exc:
    raise SystemExit(f'Could not parse GNOME Shell {action} list: {exc}')
if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
    raise SystemExit('GNOME Shell extension list has an unexpected format')

# Preserve order and remove accidental duplicates while changing only our UUID.
seen = set()
clean = []
for item in values:
    if item in seen:
        continue
    seen.add(item)
    clean.append(item)

if action == 'add':
    if uuid not in seen:
        clean.append(uuid)
elif action == 'remove':
    clean = [item for item in clean if item != uuid]
else:
    raise SystemExit('Unknown list update action')

print(repr(clean))
PYGSET
)" || return 1

    gsettings set org.gnome.shell "$key" "$new_value"
}

shell_extension_list_contains() {
    local key="$1"
    local current

    current="$(gsettings get org.gnome.shell "$key")" || return 1
    python3 - "$current" "$EXPECTED_UUID" <<'PYCONTAINS'
import ast
import sys

raw = sys.argv[1].strip()
if raw.startswith('@as '):
    raw = raw[4:].strip()
try:
    values = ast.literal_eval(raw)
except Exception:
    raise SystemExit(2)
if not isinstance(values, list) or not all(isinstance(item, str) for item in values):
    raise SystemExit(2)
raise SystemExit(0 if sys.argv[2] in values else 1)
PYCONTAINS
}

persist_extension_enabled() {
    if [[ "$(gsettings writable org.gnome.shell enabled-extensions 2>/dev/null || true)" != "true" ]]; then
        fail "GNOME Shell's enabled-extensions setting is locked. The extension was installed, but this account cannot mark it to start automatically."
    fi

    update_shell_extension_list enabled-extensions add ||
        fail "Could not add $EXPECTED_UUID to GNOME Shell's enabled-extensions list."

    # If GNOME exposes disabled-extensions, remove only our UUID from it.
    # Never change the user's other disabled extensions.
    if gsettings list-keys org.gnome.shell 2>/dev/null | grep -Fxq 'disabled-extensions'; then
        if shell_extension_list_contains disabled-extensions; then
            if [[ "$(gsettings writable org.gnome.shell disabled-extensions 2>/dev/null || true)" != "true" ]]; then
                fail "GNOME Shell's disabled-extensions setting is locked and still contains $EXPECTED_UUID."
            fi
            update_shell_extension_list disabled-extensions remove ||
                fail "Could not remove $EXPECTED_UUID from GNOME Shell's disabled-extensions list."
        fi
    fi

    if ! shell_extension_list_contains enabled-extensions; then
        fail "GNOME Shell did not persist $EXPECTED_UUID in enabled-extensions."
    fi
}

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
expected_download_url = (
    f'{release_prefix}v{version_name.strip()}/'
    f'tiny-resource-monitor@local-v{version_name.strip()}.zip'
)
if not isinstance(download_url, str) or download_url != expected_download_url:
    raise SystemExit('Manifest download_url does not match the expected official GitHub Release asset')
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
printf 'Installation command completed successfully.\n'

printf 'Marking the extension to start automatically in GNOME Shell...\n'
persist_extension_enabled
printf 'Persistent enabled state: OK\n'

# If the current Shell session already knows the extension, enable it now as a convenience.
# A freshly installed extension on Wayland may only be discovered after the next login.
if gnome-extensions list --user 2>/dev/null | grep -Fxq "$EXPECTED_UUID"; then
    gnome-extensions enable "$EXPECTED_UUID" >/dev/null 2>&1 || true
fi

printf '\nInstallation complete.\n'
printf 'If the monitor is not visible yet, log out and log back in. It is already marked to start automatically; no post-login command is required.\n'
