# Changelog

- Documentation/config examples now use the canonical GitHub repository `ILoveMyProjects/ZorinTinyResourceMonitor`.

## 0.4.0

- Added a Customize page to the existing right-click preferences window.
- Added Left / Center / Right panel placement using GNOME Shell's status-area API.
- Added a Network master switch plus independent CPU, RAM, Download and Upload visibility controls.
- Added user-controlled left-to-right ordering for CPU, RAM, Download and Upload.
- Added independent colors for CPU label/value, RAM label/value, download arrow/value and upload arrow/value.
- Added per-color and global reset controls that return text to the GNOME panel theme color.
- Changed the default monitor location from Right to Left.
- Kept a tiny ellipsis right-click target if every display item is hidden, so preferences remain reachable.
- Converted the preferences UI and updater messages to English.

## 0.3.0

- Split the existing native preferences window into Network, Update and About pages.
- Kept right-click on the panel monitor as the single way to open that preferences window.
- Added an HTTPS update manifest checker.
- Added current/latest version display and a small changelog in the Update page.
- Added an explicit Update button; no package is installed automatically.
- Added update-manifest validation for UUID, integer version and GNOME Shell 46 compatibility.
- Added SHA-256 verification of downloaded release ZIP files.
- Added asynchronous downloads using libsoup 3 in the separate preferences process.
- Added installation through `Gio.Subprocess` using `gnome-extensions install --force` without shell interpolation.
- Added a GitHub Actions release workflow that builds the ZIP, calculates SHA-256, creates a GitHub Release and publishes `update.json`.
- Added automatic injection of the repository-specific update manifest URL into GitHub-built release bundles.

## 0.2.0

- Added native GNOME preferences opened with right-click on the panel monitor.
- Added automatic detection of hardware-backed network interfaces.
- Added a persistent, user-controlled network-interface priority list with up/down controls.
- The first active configured interface is used; if none is active, network throughput is hidden.
- Newly detected adapters are appended without reordering saved preferences.
- Removed the interface name from the compact top-bar display.
- Added GSettings schema for interface priorities.
- Hardened install/uninstall UUID validation before filesystem removal.
- Made `disable()` safely destroy the indicator with optional chaining.

## 0.1.0

- Initial CPU, RAM and default-route network throughput monitor for GNOME Shell 46.
