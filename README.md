# Tiny Resource Monitor

A small, customizable GNOME Shell 46 extension that shows CPU usage, RAM usage and prioritized network throughput in the top panel.

Default example:

```text
CPU 7% | RAM 31% | ↓ 3.7 MB/s | ↑ 420.1 KB/s
```

Right-click the monitor to open one native GNOME preferences window. The window contains four pages:

- **Customize** — visibility, left-to-right item order, panel area and colors.
- **Network** — detected network adapters and their priority.
- **Update** — update source, version check, changelog and installation.
- **About** — extension version, GNOME target and update-security notes.


## Quick install

Install the latest published release with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/ILoveMyProjects/ZorinTinyResourceMonitor/master/install-latest.sh | bash
```

The installer reads the current `update.json`, verifies the extension UUID, GNOME Shell compatibility, release ZIP URL and SHA-256 checksum, validates the ZIP metadata, and then installs it with `gnome-extensions install --force`.

On Wayland, log out and log back in after the first installation. Then, if necessary, enable the extension:

```bash
gnome-extensions enable tiny-resource-monitor@local
```

If you prefer to inspect the installer before running it:

```bash
curl -fLo install-latest.sh https://raw.githubusercontent.com/ILoveMyProjects/ZorinTinyResourceMonitor/master/install-latest.sh
less install-latest.sh
bash install-latest.sh
```

After the first installation, later releases can be installed from **Right click → Update → Check for updates → Update**.

## Customize

### Visibility

The network section has a master **Network** switch. CPU, RAM, Download and Upload can each be enabled or disabled independently.

If all data items are disabled, the extension keeps a tiny `⋯` right-click target in the panel so the preferences window is still reachable.

### Panel placement

Choose one of GNOME Shell's panel areas:

- **Left**
- **Center**
- **Right**

Version 0.4.0 defaults to **Left**.

### Display order

CPU, RAM, Download and Upload are stored as an ordered list. Use the up/down controls to choose the exact left-to-right order, for example:

```text
RAM 31% | CPU 7% | ↑ 420.1 KB/s | ↓ 3.7 MB/s
```

### Colors

Each semantic part can use a separate color:

- CPU label (`CPU`)
- CPU value (`7%`)
- RAM label (`RAM`)
- RAM value (`31%`)
- Download arrow (`↓`)
- Download value (`3.7 MB/s`)
- Upload arrow (`↑`)
- Upload value (`420.1 KB/s`)

An empty color setting means **use the GNOME panel theme color**. Each color can be reset individually, and **Reset colors** resets all eight values.

## Network-card priority

The Network page detects hardware-backed interfaces from `/sys/class/net` and shows them as an ordered list:

```text
1. wlp2s0
2. enp4s0
3. enx001122334455
```

Use the up/down buttons to choose priority. At runtime the monitor checks the configured list from top to bottom and uses the first active interface. If none of the configured interfaces is active, Download/Upload disappear from the panel.

Newly detected hardware is appended to the end without changing the saved order. A temporarily unplugged adapter keeps its place and is skipped until it becomes active again.

Before priorities are configured for the first time, the extension falls back to the active default-route interface.

## GitHub repository

Project repository:

```text
https://github.com/ILoveMyProjects/ZorinTinyResourceMonitor
```

Release download URL base used by `download_url`:

```text
https://github.com/ILoveMyProjects/ZorinTinyResourceMonitor/releases/download/
```

A release asset URL therefore follows this pattern:

```text
https://github.com/ILoveMyProjects/ZorinTinyResourceMonitor/releases/download/v<VERSION>/tiny-resource-monitor@local-v<VERSION>.zip
```

## Built-in updater

The Update page uses a small HTTPS JSON manifest. Nothing is checked automatically in the background; network access starts only after **Check for updates** is clicked.

Expected `update.json` format:

```json
{
  "schema": 1,
  "uuid": "tiny-resource-monitor@local",
  "version": 5,
  "version_name": "0.5.0",
  "shell_versions": ["46"],
  "download_url": "https://github.com/ILoveMyProjects/ZorinTinyResourceMonitor/releases/download/v0.5.0/tiny-resource-monitor@local-v0.5.0.zip",
  "sha256": "64_HEX_CHARACTERS",
  "changelog": [
    "First change",
    "Second change"
  ]
}
```

Before installation the updater verifies:

1. manifest format,
2. exact extension UUID,
3. integer version number,
4. declared GNOME Shell 46 compatibility,
5. HTTPS download URL,
6. SHA-256 of the downloaded ZIP.

Only after all checks pass does it run:

```text
gnome-extensions install --force <downloaded-zip>
```

The command is launched through `Gio.Subprocess` with a fixed argument vector, not through a shell command string.

After installation GNOME Shell must load the new extension code in a new session, so log out and log back in on Wayland.

### Local builds

The source-tree schema intentionally has an empty update URL. In a local development build you can paste the HTTPS URL to `update.json` into the **Update** page.

GitHub release bundles do not need this manual step: the included GitHub Actions workflow injects the correct repository-specific raw `update.json` URL while building the release ZIP.

## GitHub release workflow

The repository includes `.github/workflows/release.yml`.

For a new release:

1. Increment integer `version` in `metadata.json`.
2. Set `version-name`, for example `0.5.0`.
3. Update `RELEASE_NOTES.md`.
4. Commit and push the source.
5. Create and push a matching tag:

```bash
git tag v0.5.0
git push origin v0.5.0
```

GitHub Actions then automatically checks the tag, injects the update URL, builds the extension ZIP, calculates SHA-256, generates `update.json`, creates a GitHub Release and publishes the new manifest to the default branch.

Client machines download the already-built release ZIP; they do not build or compile the extension themselves.

## Runtime design

The panel component has no network access and launches no subprocesses. Every second it reads only the required Linux kernel/system interfaces:

- `/proc/stat` — CPU counters, only when CPU display is enabled
- `/proc/meminfo` — RAM counters, only when RAM display is enabled
- `/proc/net/route` and `/proc/net/ipv6_route` — default-route fallback
- `/sys/class/net/<iface>/operstate` and `carrier` — active-interface check
- `/sys/class/net/<iface>/statistics/rx_bytes`
- `/sys/class/net/<iface>/statistics/tx_bytes`

Network counters are not read when the Network master switch is off or both Download and Upload are disabled.

Preferences enumerate `/sys/class/net` to discover physical adapters. Internet access exists only in `prefs.js` and only for an explicitly requested update check/download.

## Compatibility

This release intentionally targets:

- GNOME Shell **46**
- Linux

## Install from source

```bash
./install.sh
```

For the first installation GNOME Shell may need to reload the extension list.

### Wayland

Log out and log back in, then:

```bash
gnome-extensions enable tiny-resource-monitor@local
```

### X11

Press `Alt+F2`, enter `r`, press Enter, then:

```bash
gnome-extensions enable tiny-resource-monitor@local
```

Open preferences from the terminal if needed:

```bash
gnome-extensions prefs tiny-resource-monitor@local
```

or right-click the monitor in the top bar.

## Uninstall

```bash
./uninstall.sh
```

## Build a local GNOME extension ZIP

```bash
./package.sh
```

The publishable extension bundle is placed in `dist/`. On GNOME 44+ settings schemas are compiled automatically when installing with `gnome-extensions`.

## Debugging

```bash
gnome-extensions info tiny-resource-monitor@local
journalctl --user -b -f /usr/bin/gnome-shell
```

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
