# Tiny Resource Monitor

A deliberately small GNOME Shell 46 extension that shows CPU usage, RAM usage and network throughput in the top panel.

Example:

```text
CPU 7% | RAM 31% | ↓ 3.7 MB/s ↑ 420.1 KB/s
```

Right-click the monitor to open one native GNOME preferences window. The window is split into three pages at the top:

- **Network** — detected network adapters and their priority.
- **Update** — update source, version check, changelog and installation.
- **About** — extension version, GNOME target and security notes.

## Network-card priority

The Network page detects hardware-backed interfaces from `/sys/class/net` and shows them as an ordered list:

```text
1. wlp2s0
2. enp4s0
3. enx001122334455
```

Use the up/down buttons to choose priority. At runtime the monitor checks the configured list from top to bottom and uses the first active interface. If none of the configured interfaces is active, the network section is hidden and only CPU/RAM remain visible.

Newly detected hardware is appended to the end without changing the saved order. A temporarily unplugged adapter keeps its place and is skipped until it becomes active again.

Before priorities are configured for the first time, the extension falls back to the active default-route interface.

## Built-in updater

The Update page uses a small HTTPS JSON manifest. Nothing is checked automatically in the background; network access starts only after **Check for updates** is clicked.

Expected `update.json` format:

```json
{
  "schema": 1,
  "uuid": "tiny-resource-monitor@local",
  "version": 4,
  "version_name": "0.4.0",
  "shell_versions": ["46"],
  "download_url": "https://github.com/OWNER/REPOSITORY/releases/download/v0.4.0/tiny-resource-monitor@local-v0.4.0.zip",
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

The repository includes:

```text
.github/workflows/release.yml
```

The intended release flow is:

1. Update `metadata.json`:
   - increment integer `version`,
   - set `version-name`, for example `0.4.0`.
2. Update `RELEASE_NOTES.md` with the short changelog for this release.
3. Commit and push the source.
4. Create and push a matching tag:

```bash
git tag v0.4.0
git push origin v0.4.0
```

GitHub Actions then automatically:

- checks that the tag matches `version-name`,
- injects the stable `update.json` URL into the release bundle,
- builds `tiny-resource-monitor@local-vX.Y.Z.zip`,
- calculates SHA-256,
- generates `update.json`,
- creates a GitHub Release and uploads the ZIP,
- writes the new `update.json` to the repository's default branch.

This means client machines download the already-built release ZIP; they do not build or compile the extension themselves.

The workflow needs the repository's normal GitHub Actions **contents: write** permission. If the default branch is protected against bot pushes, allow the workflow to update `update.json` or adapt that final publishing step to your branch policy.

## Why this exists

The monitor is intentionally not a full system-monitoring suite. It has no graphs, history, process list, temperatures, disk monitor or background daemon.

Every second the panel component reads only Linux kernel/system interfaces:

- `/proc/stat` — CPU counters
- `/proc/meminfo` — RAM counters
- `/proc/net/route` — IPv4 default route fallback
- `/proc/net/ipv6_route` — IPv6 default route fallback
- `/sys/class/net/<iface>/operstate` and `carrier` — active-interface check
- `/sys/class/net/<iface>/statistics/rx_bytes`
- `/sys/class/net/<iface>/statistics/tx_bytes`

Preferences additionally enumerate `/sys/class/net` to discover physical network adapters. Network access exists only in `prefs.js` for the explicitly requested update check/download.

## Compatibility

This release intentionally targets:

- GNOME Shell **46**
- Linux

It was designed for GNOME 46 systems such as Zorin OS 18. Other GNOME Shell versions are not declared supported until tested.

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

## Design notes

- One panel label.
- One GLib timer, once per second.
- No subprocesses or background daemon in the panel component.
- Native GNOME preferences (`prefs.js`) with GSettings.
- Right-click opens the same preferences window with Network / Update / About pages.
- Update network traffic is user initiated and asynchronous.
- CPU is calculated from deltas of `/proc/stat` counters.
- RAM uses `MemTotal - MemAvailable`.
- Network speed uses byte-counter deltas divided by monotonic elapsed time.
- The interface name is omitted from the compact top-bar text.
- The timer is removed and the panel object is safely destroyed in `disable()`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
