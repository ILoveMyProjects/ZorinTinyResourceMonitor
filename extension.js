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

function setLabelColor(label, color) {
    // Inline St.Widget CSS overrides the panel theme for this label only.
    // Keeping title and value as separate actors avoids Pango-markup/theme
    // interactions and makes every configured color independent.
    label.set_style(color ? `color: ${color};` : '');
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

    _createMetricActor(title) {
        const box = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        const titleLabel = new St.Label({
            text: title,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const spacer = new St.Label({
            text: ' ',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const valueLabel = new St.Label({
            text: '--',
            y_align: Clutter.ActorAlign.CENTER,
        });

        box.add_child(titleLabel);
        box.add_child(spacer);
        box.add_child(valueLabel);

        return {box, titleLabel, valueLabel};
    }

    _buildIndicator() {
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, true);
        this._contentBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._contentBox);

        this._metrics = {
            cpu: this._createMetricActor('CPU'),
            ram: this._createMetricActor('RAM'),
            download: this._createMetricActor('↓'),
            upload: this._createMetricActor('↑'),
        };
        this._separators = Array.from({length: 3}, () => new St.Label({
            text: ' | ',
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._emptyLabel = new St.Label({
            text: '⋯',
            y_align: Clutter.ActorAlign.CENTER,
        });

        for (const item of DISPLAY_ITEMS)
            this._contentBox.add_child(this._metrics[item].box);
        for (const separator of this._separators)
            this._contentBox.add_child(separator);
        this._contentBox.add_child(this._emptyLabel);

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
        this._contentBox = null;
        this._metrics = null;
        this._separators = null;
        this._emptyLabel = null;
        this._buildIndicator();
    }

    _renderMetrics(values, colors, visibleItems) {
        const metricColors = {
            cpu: [colors.cpuTitle, colors.cpuValue],
            ram: [colors.ramTitle, colors.ramValue],
            download: [colors.downloadTitle, colors.downloadValue],
            upload: [colors.uploadTitle, colors.uploadValue],
        };

        for (const item of DISPLAY_ITEMS) {
            const metric = this._metrics[item];
            metric.valueLabel.text = values[item];
            setLabelColor(metric.titleLabel, metricColors[item][0]);
            setLabelColor(metric.valueLabel, metricColors[item][1]);
            metric.box.hide();
        }

        for (const separator of this._separators)
            separator.hide();
        this._emptyLabel.hide();

        if (visibleItems.length === 0) {
            this._contentBox.set_child_at_index(this._emptyLabel, 0);
            this._emptyLabel.show();
            return;
        }

        let childIndex = 0;
        visibleItems.forEach((item, index) => {
            const metric = this._metrics[item];
            this._contentBox.set_child_at_index(metric.box, childIndex++);
            metric.box.show();

            if (index < visibleItems.length - 1) {
                const separator = this._separators[index];
                this._contentBox.set_child_at_index(separator, childIndex++);
                separator.show();
            }
        });
    }

    _update() {
        if (!this._contentBox || !this._metrics || !this._settings)
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

            const values = {
                cpu: cpuText,
                ram: ramText,
                download: formatRate(rxRate),
                upload: formatRate(txRate),
            };
            const isVisible = {
                cpu: showCpu,
                ram: showRam,
                download: networkNeeded && Boolean(iface) && showDownload,
                upload: networkNeeded && Boolean(iface) && showUpload,
            };
            const visibleItems = getDisplayOrder(this._settings)
                .filter(item => isVisible[item]);

            // Separate St.Label actors give title/value colors independent inline CSS.
            this._renderMetrics(values, colors, visibleItems);
            this._lastLoggedError = null;
        } catch (error) {
            for (const item of DISPLAY_ITEMS)
                this._metrics?.[item]?.box.hide();
            for (const separator of this._separators ?? [])
                separator.hide();
            if (this._emptyLabel) {
                this._contentBox.set_child_at_index(this._emptyLabel, 0);
                this._emptyLabel.show();
            }

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
        this._contentBox = null;
        this._metrics = null;
        this._separators = null;
        this._emptyLabel = null;
        this._settings = null;
        this._previousCpu = null;
        this._previousNetwork = null;
        this._previousTimestamp = null;
        this._lastLoggedError = null;
        decoder = null;
    }
}
