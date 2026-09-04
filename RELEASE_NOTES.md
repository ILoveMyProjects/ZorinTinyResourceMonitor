# 0.5.0

- Added independent top-panel placement for CPU, RAM, Download and Upload.
- Added six placement slots for every item: Left near/far from Activities, Center before/after Date & Time, and Right before/after System Menu.
- Kept user-defined ordering when multiple items share the same placement slot.
- Changed the default layout so CPU/RAM start on the left while Download/Upload start before the System Menu on the right.
- Added Dynamic / Fixed value-width modes for Download and Upload.
- Fixed network value width keeps changing transfer rates from shifting nearby panel items.
- Hardened per-part color rendering by applying the configured foreground directly to each Clutter text actor, including the Download arrow.
- Kept the update source locked to the official ILoveMyProjects/ZorinTinyResourceMonitor repository.
- Kept one-command installation with automatic persistent enablement for the next GNOME session.
