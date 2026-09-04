// SPDX-License-Identifier: GPL-3.0-or-later
// Generated with AI for personal use.
// Do NOT upload to extensions.gnome.org (EGO) unless you understand JavaScript
// and can maintain this code.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

const UPDATE_INTERVAL_SECONDS = 1;
const DISPLAY_ITEMS = ['cpu', 'ram', 'download', 'upload'];
const PANEL_AREAS = new Set(['left', 'center', 'right']);
const COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
let decoder = null;

function readText(path) {
    const file = Gio.File.new_for_path(path);
    const [, contents] = file.load_contents(null);
    return decoder.decode(contents);
}

function readCpuSample() {
    const line = readText('/proc/stat').split('\n', 1)[0];
    const fields = line.trim().split(/\s+/);

    if (fields[0] !== 'cpu' || fields.length < 8)
        throw new Error('Unexpected /proc/stat format');

    const values = fields.slice(1).map(Number);
    const user = values[0] ?? 0;
    const nice = values[1] ?? 0;
    const system = values[2] ?? 0;
    const idle = values[3] ?? 0;
    const iowait = values[4] ?? 0;
    const irq = values[5] ?? 0;
    const softirq = values[6] ?? 0;
    const steal = values[7] ?? 0;

    // guest and guest_nice are already included in user/nice, so do not add them.
    return {
        idle: idle + iowait,
        total: user + nice + system + idle + iowait + irq + softirq + steal,
    };
}

function calculateCpuPercent(previous, current) {
    if (!previous)
        return null;

    const totalDelta = current.total - previous.total;
    const idleDelta = current.idle - previous.idle;

    if (totalDelta <= 0)
        return 0;

    const busy = totalDelta - idleDelta;
    return Math.max(0, Math.min(100, (busy / totalDelta) * 100));
}

function readMemoryPercent() {
    const values = new Map();

    for (const line of readText('/proc/meminfo').split('\n')) {
        const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
        if (match)
            values.set(match[1], Number(match[2]));
    }

    const total = values.get('MemTotal');
    const available = values.get('MemAvailable');

    if (!total || available === undefined)
        throw new Error('MemTotal/MemAvailable missing from /proc/meminfo');

    return ((total - available) / total) * 100;
}

function readDefaultIpv4Interface() {
    let best = null;
    const lines = readText('/proc/net/route').trim().split('\n').slice(1);

    for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 8)
            continue;

        const iface = fields[0];
        const destination = fields[1];
        const flags = Number.parseInt(fields[3], 16);
        const metric = Number(fields[6]);

        if (iface === 'lo' || destination !== '00000000')
            continue;
        if (!Number.isFinite(flags) || (flags & 0x1) === 0)
            continue;
        if (!Number.isFinite(metric))
            continue;

        if (!best || metric < best.metric)
            best = {iface, metric};
    }

    return best?.iface ?? null;
}

function readDefaultIpv6Interface() {
    let routeText;
    try {
        routeText = readText('/proc/net/ipv6_route');
    } catch {
        return null;
    }

    let best = null;
    const zeroDestination = '0'.repeat(32);
    const lines = routeText.trim().split('\n');

    for (const line of lines) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 10)
            continue;

        const destination = fields[0];
        const destinationPrefixLength = fields[1];
        const metric = Number.parseInt(fields[5], 16);
        const flags = Number.parseInt(fields[8], 16);
        const iface = fields[9];

        if (iface === 'lo' || destination !== zeroDestination || destinationPrefixLength !== '00')
            continue;
        if (!Number.isFinite(flags) || (flags & 0x1) === 0)
            continue;
        if (!Number.isFinite(metric))
            continue;

        if (!best || metric < best.metric)
            best = {iface, metric};
    }

    return best?.iface ?? null;
}

function readDefaultInterface() {
    return readDefaultIpv4Interface() ?? readDefaultIpv6Interface();
}

function isSafeInterfaceName(iface) {
    return Boolean(iface) && iface !== '.' && iface !== '..' && !iface.includes('/');
}

function isInterfaceActive(iface) {
    if (!isSafeInterfaceName(iface))
        return false;

    try {
        const operstate = readText(`/sys/class/net/${iface}/operstate`).trim();
        if (operstate !== 'up')
            return false;

        try {
            return readText(`/sys/class/net/${iface}/carrier`).trim() === '1';
        } catch {
            return false;
        }
    } catch {
        return false;
    }
}

function readNetworkCounters(iface) {
    if (!isSafeInterfaceName(iface))
        return null;

    const base = `/sys/class/net/${iface}/statistics`;

    try {
        return {
            rx: BigInt(readText(`${base}/rx_bytes`).trim()),
            tx: BigInt(readText(`${base}/tx_bytes`).trim()),
        };
    } catch {
        return null;
    }
}

function selectNetworkInterface(settings) {
    const priority = settings.get_strv('interface-priority');

    if (priority.length > 0) {
        for (const iface of priority) {
            if (isInterfaceActive(iface))
                return iface;
        }
        return null;
    }

    const fallback = readDefaultInterface();
    return fallback && isInterfaceActive(fallback) ? fallback : null;
}

function formatRate(bytesPerSecond) {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0)
        return '0 B/s';

    if (bytesPerSecond < 1_000)
        return `${Math.round(bytesPerSecond)} B/s`;
    if (bytesPerSecond < 1_000_000)
        return `${(bytesPerSecond / 1_000).toFixed(1)} KB/s`;
    if (bytesPerSecond < 1_000_000_000)
        return `${(bytesPerSecond / 1_000_000).toFixed(1)} MB/s`;

    return `${(bytesPerSecond / 1_000_000_000).toFixed(1)} GB/s`;
}

function getDisplayOrder(settings) {
    const configured = settings.get_strv('display-order');
    const order = [];
    const seen = new Set();

    for (const item of configured) {
        if (DISPLAY_ITEMS.includes(item) && !seen.has(item)) {
            order.push(item);
            seen.add(item);
        }
    }

    for (const item of DISPLAY_ITEMS) {
        if (!seen.has(item))
            order.push(item);
    }

    return order;
}

function getPanelArea(settings) {
    const value = settings.get_string('panel-location');
    return PANEL_AREAS.has(value) ? value : 'right';
}

function getColor(settings, key) {
    const value = settings.get_string(key).trim();
    return COLOR_PATTERN.test(value) ? value : null;
}

function span(text, color) {
    return color ? `<span foreground="${color}">${text}</span>` : text;
}

function metricMarkup(title, value, titleColor, valueColor) {
    return `${span(title, titleColor)} ${span(value, valueColor)}`;
}

export default class TinyResourceMonitorExtension extends Extension {
    enable() {
        decoder = new TextDecoder('utf-8');
        this._settings = this.getSettings();
        this._previousCpu = null;
        this._previousNetwork = null;
        this._previousTimestamp = null;
        this._lastLoggedError = null;

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (
                key === 'interface-priority' ||
                key === 'show-network' ||
                key === 'show-download' ||
                key === 'show-upload'
            ) {
                this._previousNetwork = null;
                this._previousTimestamp = null;
            }

            if (key === 'show-cpu')
                this._previousCpu = null;

            if (key === 'panel-location')
                this._rebuildIndicator();

            this._update();
        });

        this._buildIndicator();
        this._update();

        this._timeoutId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            UPDATE_INTERVAL_SECONDS,
            () => {
                this._update();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, true);
        this._label = new St.Label({
            text: 'CPU -- | RAM --',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._label);

        // Right click always opens the same native preferences window.
        this._indicator.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 3) {
                this.openPreferences();
                return true;
            }
            return false;
        });

        Main.panel.addToStatusArea(
            this.uuid,
            this._indicator,
            0,
            getPanelArea(this._settings)
        );
    }

    _rebuildIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
        this._label = null;
        this._buildIndicator();
    }

    _update() {
        if (!this._label || !this._settings)
            return;

        try {
            const now = GLib.get_monotonic_time();
            const showCpu = this._settings.get_boolean('show-cpu');
            const showRam = this._settings.get_boolean('show-ram');
            const showNetwork = this._settings.get_boolean('show-network');
            const showDownload = this._settings.get_boolean('show-download');
            const showUpload = this._settings.get_boolean('show-upload');
            const networkNeeded = showNetwork && (showDownload || showUpload);

            let cpuText = '--';
            if (showCpu) {
                const cpu = readCpuSample();
                const cpuPercent = calculateCpuPercent(this._previousCpu, cpu);
                this._previousCpu = cpu;
                cpuText = cpuPercent === null ? '--' : `${Math.round(cpuPercent)}%`;
            } else {
                this._previousCpu = null;
            }

            let ramText = '--';
            if (showRam)
                ramText = `${Math.round(readMemoryPercent())}%`;

            let iface = null;
            let rxRate = 0;
            let txRate = 0;

            if (networkNeeded) {
                iface = selectNetworkInterface(this._settings);
                const counters = iface ? readNetworkCounters(iface) : null;

                if (
                    counters &&
                    this._previousNetwork &&
                    this._previousNetwork.iface === iface &&
                    this._previousTimestamp !== null
                ) {
                    const seconds = (now - this._previousTimestamp) / 1_000_000;

                    if (seconds > 0) {
                        const rxDelta = counters.rx >= this._previousNetwork.rx
                            ? counters.rx - this._previousNetwork.rx
                            : 0n;
                        const txDelta = counters.tx >= this._previousNetwork.tx
                            ? counters.tx - this._previousNetwork.tx
                            : 0n;

                        rxRate = Number(rxDelta) / seconds;
                        txRate = Number(txDelta) / seconds;
                    }
                }

                this._previousNetwork = counters ? {iface, ...counters} : null;
                this._previousTimestamp = now;
            } else {
                this._previousNetwork = null;
                this._previousTimestamp = null;
            }

            const colors = {
                cpuTitle: getColor(this._settings, 'cpu-title-color'),
                cpuValue: getColor(this._settings, 'cpu-value-color'),
                ramTitle: getColor(this._settings, 'ram-title-color'),
                ramValue: getColor(this._settings, 'ram-value-color'),
                downloadTitle: getColor(this._settings, 'download-title-color'),
                downloadValue: getColor(this._settings, 'download-value-color'),
                uploadTitle: getColor(this._settings, 'upload-title-color'),
                uploadValue: getColor(this._settings, 'upload-value-color'),
            };

            const items = {
                cpu: showCpu
                    ? metricMarkup('CPU', cpuText, colors.cpuTitle, colors.cpuValue)
                    : null,
                ram: showRam
                    ? metricMarkup('RAM', ramText, colors.ramTitle, colors.ramValue)
                    : null,
                download: networkNeeded && iface && showDownload
                    ? metricMarkup('↓', formatRate(rxRate), colors.downloadTitle, colors.downloadValue)
                    : null,
                upload: networkNeeded && iface && showUpload
                    ? metricMarkup('↑', formatRate(txRate), colors.uploadTitle, colors.uploadValue)
                    : null,
            };

            const parts = [];
            for (const item of getDisplayOrder(this._settings)) {
                if (items[item])
                    parts.push(items[item]);
            }

            // Keep a tiny right-click target if the user hides every item.
            // It contains no resource data and prevents locking the user out of prefs.
            this._label.clutter_text.set_markup(parts.length > 0 ? parts.join(' | ') : '⋯');
            this._lastLoggedError = null;
        } catch (error) {
            this._label.text = '⋯';

            const message = error instanceof Error ? error.message : String(error);
            if (message !== this._lastLoggedError) {
                console.error(`[${this.uuid}] ${message}`);
                this._lastLoggedError = message;
            }
        }
    }

    disable() {
        if (this._timeoutId) {
            GLib.Source.remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._settings && this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }

        this._indicator?.destroy();
        this._indicator = null;
        this._label = null;
        this._settings = null;
        this._previousCpu = null;
        this._previousNetwork = null;
        this._previousTimestamp = null;
        this._lastLoggedError = null;
        decoder = null;
    }
}
