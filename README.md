# Tiny Resource Monitor

A small, customizable GNOME Shell 46 extension that shows CPU usage, RAM usage and prioritized network throughput in the top panel.

Default example:

```text
CPU 7% | RAM 31% | ↓ 3.7 MB/s | ↑ 420.1 KB/s
```

Right-click the monitor to open one native GNOME preferences window. The window contains four pages:

- **Customize** — per-item placement, visibility/order, network value width and colors.
- **Network** — detected network adapters and their priority.
- **Update** — fixed official update source, version check, changelog and installation.
- **About** — extension version, GNOME target and update-security notes.


## Quick install

Install the latest published release with one command:

```bash
curl -fsSL https://raw.githubusercontent.com/ILoveMyProjects/ZorinTinyResourceMonitor/master/install-latest.sh | bash
```

The installer reads the current `update.json`, verifies the extension UUID, GNOME Shell compatibility, official release ZIP URL and SHA-256 checksum, validates the ZIP metadata, installs it with `gnome-extensions install --force`, and safely adds `tiny-resource-monitor@local` to GNOME Shell's existing `enabled-extensions` list. It does not replace or remove the user's other enabled extensions.

On Wayland, if the monitor is not visible immediately after the first installation, **log out and log back in**. The extension is already marked to start automatically; there is no command to run after login.

If you prefer to inspect the installer before running it:

```bash
curl -fLo install-latest.sh https://raw.githubusercontent.com/ILoveMyProjects/ZorinTinyResourceMonitor/master/install-latest.sh
less install-latest.sh
bash install-latest.sh
```

After the first installation, later releases can be installed from **Right click → Update → Check for updates → Update**.

## Customize

### Independent placement

CPU, RAM, Download and Upload can each be placed independently. Every item has the same six placement choices:

- **Left · Near Activities**
- **Left · Far from Activities**
- **Center · Before Date & Time**
- **Center · After Date & Time**
- **Right · Before System Menu**
- **Right · After System Menu**

This makes layouts such as these possible:

```text
Left:   RAM 31%
Center: ↓ 3.7 MB/s
Right:  CPU 7% | ↑ 420.1 KB/s
```

or CPU before the System Menu while RAM remains near Activities.

The v0.5.x defaults are CPU and RAM near Activities on the left, with Download and Upload before the System Menu on the right.

Precise before/after placement uses GNOME Shell 46 panel anchors (`Activities`, `Date & Time`, and `System Menu`). It is intentionally targeted to GNOME Shell 46.

### Visibility

The network section has a master **Network** switch. CPU, RAM, Download and Upload can each be enabled or disabled independently.

If all data items are disabled, the extension keeps a tiny `⋯` right-click target in the panel so the preferences window is still reachable.

### Order inside a shared placement

Use the up/down controls to set ordering when two or more items use the same placement slot. For example, if CPU and RAM are both `Left · Near Activities`, they can appear as either:

```text
CPU 7% | RAM 31%
```

or:

```text
RAM 31% | CPU 7%
```

Items assigned to different placement slots are independent of this ordering.

### Network value width

Download and Upload each have an independent **Value width** option:

- **Dynamic** — the value field follows the current text width.
- **Fixed** — the value field keeps a compact stable width so changing transfer-rate strings do not move nearby panel content.

`Fixed` prevents nearby panel content from jumping when a value changes between strings such as `132 B/s`, `14.4 KB/s` and `1.2 MB/s`. Items that share one placement slot are grouped into one compact panel indicator to avoid repeated GNOME Shell button padding.

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

The panel renderer keeps every title/value in a separate text actor and applies configured foreground colors independently, including the Download arrow.

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

The Update page uses a small HTTPS JSON manifest from the fixed official project repository. The source cannot be edited in preferences. Nothing is checked automatically in the background; network access starts only after **Check for updates** is clicked.

Expected `update.json` format:

```json
{
  "schema": 1,
  "uuid": "tiny-resource-monitor@local",
  "version": 6,
  "version_name": "0.5.1",
  "shell_versions": ["46"],
  "download_url": "https://github.com/ILoveMyProjects/ZorinTinyResourceMonitor/releases/download/v0.5.1/tiny-resource-monitor@local-v0.5.1.zip",
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
5. download URL is under `https://github.com/ILoveMyProjects/ZorinTinyResourceMonitor/releases/download/`,
6. SHA-256 of the downloaded ZIP.

Only after all checks pass does it run:

```text
gnome-extensions install --force <downloaded-zip>
```

The command is launched through `Gio.Subprocess` with a fixed argument vector, not through a shell command string.

After installation GNOME Shell must load the new extension code in a new session, so log out and log back in on Wayland.

### Fixed update source

The update manifest is hard-coded to:

```text
https://raw.githubusercontent.com/ILoveMyProjects/ZorinTinyResourceMonitor/master/update.json
```

The package download URL must also stay under this project's GitHub Releases path. There is no editable GSettings key or preferences field for changing the update source. Local development builds use the same official source when **Check for updates** is clicked.

## GitHub release workflow

The repository includes `.github/workflows/release.yml`.

For a new release:

1. Increment integer `version` in `metadata.json`.
2. Set `version-name`, for example `0.5.1`.
3. Update `RELEASE_NOTES.md`.
4. Commit and push the source.
5. Create and push a matching tag:

```bash
git tag v0.5.1
git push origin v0.5.1
```

GitHub Actions then automatically checks the tag, builds the extension ZIP, calculates SHA-256, generates `update.json`, creates a GitHub Release and publishes the new manifest to the default branch.

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

When using `install-latest.sh`, log out and log back in if the monitor is not visible immediately. The installer has already persisted the enabled state.

When using the low-level `./install.sh` developer helper instead, GNOME may still require manual enablement because that helper intentionally does not modify the user's GNOME Shell enabled-extension list.

### X11

When using `install-latest.sh`, the extension is marked enabled automatically. If GNOME Shell has not discovered the fresh install yet, restart the Shell session (for example with `Alt+F2`, `r`) or log out and back in.

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
