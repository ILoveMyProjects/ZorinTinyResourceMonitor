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
const NETWORK_FIXED_VALUE_WIDTH = 96;
const DISPLAY_ITEMS = ['cpu', 'ram', 'download', 'upload'];
const DISPLAY_TITLES = {
    cpu: 'CPU',
    ram: 'RAM',
    download: '↓',
    upload: '↑',
};
const ITEM_LOCATION_KEYS = {
    cpu: 'cpu-location',
    ram: 'ram-location',
    download: 'download-location',
    upload: 'upload-location',
};
const DEFAULT_ITEM_LOCATIONS = {
    cpu: 'left-near-activities',
    ram: 'left-near-activities',
    download: 'right-before-system',
    upload: 'right-before-system',
};
const PLACEMENTS = [
    'left-near-activities',
    'left-far-activities',
    'center-before-clock',
    'center-after-clock',
    'right-before-system',
    'right-after-system',
];
const PLACEMENT_SET = new Set(PLACEMENTS);
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

function getItemPlacement(settings, item) {
    const key = ITEM_LOCATION_KEYS[item];
    const value = key ? settings.get_string(key) : '';
    return PLACEMENT_SET.has(value) ? value : DEFAULT_ITEM_LOCATIONS[item];
}

function getColor(settings, key) {
    const value = settings.get_string(key).trim();
    return COLOR_PATTERN.test(value) ? value : null;
}

function setLabelColor(label, color) {
    let clutterColor = null;

    if (color) {
        const [ok, parsed] = Clutter.Color.from_string(color);
        if (ok)
            clutterColor = parsed;
    }

    if (!clutterColor)
        clutterColor = label.get_theme_node().get_foreground_color();

    // Set the Clutter.Text foreground directly. This avoids theme/markup
    // interactions and makes the network arrow colors independent too.
    label.clutter_text.set_color(clutterColor);
}

function getPanelBox(area) {
    if (area === 'left')
        return Main.panel._leftBox;
    if (area === 'center')
        return Main.panel._centerBox;
    return Main.panel._rightBox;
}

function getAnchorContainer(roleCandidates) {
    for (const role of roleCandidates) {
        const indicator = Main.panel.statusArea?.[role];
        if (indicator?.container)
            return indicator.container;
    }
    return null;
}

function getPlacementDefinition(placement) {
    switch (placement) {
    case 'left-near-activities':
        return {area: 'left', anchorRoles: ['activities'], relation: 'after'};
    case 'left-far-activities':
        return {area: 'left', relation: 'end'};
    case 'center-before-clock':
        return {area: 'center', anchorRoles: ['dateMenu'], relation: 'before'};
    case 'center-after-clock':
        return {area: 'center', anchorRoles: ['dateMenu'], relation: 'after'};
    case 'right-before-system':
        return {area: 'right', anchorRoles: ['quickSettings', 'aggregateMenu'], relation: 'before'};
    case 'right-after-system':
        return {area: 'right', anchorRoles: ['quickSettings', 'aggregateMenu'], relation: 'after'};
    default:
        return {area: 'left', anchorRoles: ['activities'], relation: 'after'};
    }
}

function getPlacementBaseIndex(placement) {
    const definition = getPlacementDefinition(placement);
    const box = getPanelBox(definition.area);
    const children = box?.get_children?.() ?? [];

    if (definition.relation === 'end')
        return {area: definition.area, index: children.length};

    const anchor = getAnchorContainer(definition.anchorRoles ?? []);
    const anchorIndex = anchor ? children.indexOf(anchor) : -1;

    if (anchorIndex < 0) {
        return {
            area: definition.area,
            index: definition.relation === 'before' ? 0 : children.length,
        };
    }

    return {
        area: definition.area,
        index: anchorIndex + (definition.relation === 'after' ? 1 : 0),
    };
}

function setIndicatorVisible(indicator, visible) {
    const actor = indicator?.container ?? indicator;
    if (!actor)
        return;

    if (visible)
        actor.show();
    else
        actor.hide();
}

export default class TinyResourceMonitorExtension extends Extension {
    enable() {
        decoder = new TextDecoder('utf-8');
        this._settings = this.getSettings();
        this._previousCpu = null;
        this._previousNetwork = null;
        this._previousTimestamp = null;
        this._lastLoggedError = null;
        this._metrics = null;
        this._fallback = null;

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

            if (
                key === 'display-order' ||
                key === 'cpu-location' ||
                key === 'ram-location' ||
                key === 'download-location' ||
                key === 'upload-location'
            ) {
                this._rebuildIndicators();
            }

            this._update();
        });

        this._buildIndicators();
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

    _connectRightClick(indicator) {
        indicator.connect('button-press-event', (_actor, event) => {
            if (event.get_button() === 3) {
                this.openPreferences();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    _createMetricIndicator(item) {
        const indicator = new PanelMenu.Button(
            0.0,
            `${this.metadata.name}: ${item}`,
            true
        );
        const contentBox = new St.BoxLayout({
            y_align: Clutter.ActorAlign.CENTER,
        });
        const separatorLabel = new St.Label({
            text: ' | ',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const titleLabel = new St.Label({
            text: DISPLAY_TITLES[item],
            y_align: Clutter.ActorAlign.CENTER,
        });
        const spacerLabel = new St.Label({
            text: ' ',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const valueLabel = new St.Label({
            text: '--',
            y_align: Clutter.ActorAlign.CENTER,
        });
        const valueBin = new St.Bin({
            child: valueLabel,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });

        contentBox.add_child(separatorLabel);
        contentBox.add_child(titleLabel);
        contentBox.add_child(spacerLabel);
        contentBox.add_child(valueBin);
        indicator.add_child(contentBox);
        this._connectRightClick(indicator);

        return {
            item,
            indicator,
            contentBox,
            separatorLabel,
            titleLabel,
            valueLabel,
            valueBin,
        };
    }

    _createFallbackIndicator() {
        const indicator = new PanelMenu.Button(0.0, this.metadata.name, true);
        const label = new St.Label({
            text: '⋯',
            y_align: Clutter.ActorAlign.CENTER,
        });
        indicator.add_child(label);
        this._connectRightClick(indicator);
        return {indicator, label};
    }

    _buildIndicators() {
        this._metrics = {};
        for (const item of DISPLAY_ITEMS)
            this._metrics[item] = this._createMetricIndicator(item);

        const order = getDisplayOrder(this._settings);

        for (const placement of PLACEMENTS) {
            const items = order.filter(item => getItemPlacement(this._settings, item) === placement);
            if (items.length === 0)
                continue;

            const {area, index} = getPlacementBaseIndex(placement);
            items.forEach((item, groupIndex) => {
                const metric = this._metrics[item];
                metric.separatorLabel.visible = groupIndex > 0;
                Main.panel.addToStatusArea(
                    `${this.uuid}-${item}`,
                    metric.indicator,
                    index + groupIndex,
                    area
                );
            });
        }

        this._fallback = this._createFallbackIndicator();
        const fallbackPlacement = getPlacementBaseIndex('left-near-activities');
        Main.panel.addToStatusArea(
            `${this.uuid}-fallback`,
            this._fallback.indicator,
            fallbackPlacement.index,
            fallbackPlacement.area
        );
        setIndicatorVisible(this._fallback.indicator, false);
    }

    _destroyIndicators() {
        if (this._metrics) {
            for (const item of DISPLAY_ITEMS)
                this._metrics[item]?.indicator?.destroy();
        }
        this._fallback?.indicator?.destroy();
        this._metrics = null;
        this._fallback = null;
    }

    _rebuildIndicators() {
        this._destroyIndicators();
        this._buildIndicators();
    }

    _applyNetworkValueWidth(item) {
        const metric = this._metrics?.[item];
        if (!metric)
            return;

        const mode = this._settings.get_string(`${item}-width-mode`);
        const fixed = mode === 'fixed';
        metric.valueBin.set_width(fixed ? NETWORK_FIXED_VALUE_WIDTH : -1);
    }

    _renderMetrics(values, colors, isVisible) {
        const metricColors = {
            cpu: [colors.cpuTitle, colors.cpuValue],
            ram: [colors.ramTitle, colors.ramValue],
            download: [colors.downloadTitle, colors.downloadValue],
            upload: [colors.uploadTitle, colors.uploadValue],
        };

        let visibleCount = 0;
        const separatorVisible = new Map();
        const order = getDisplayOrder(this._settings);

        for (const placement of PLACEMENTS) {
            const visibleInPlacement = order.filter(item =>
                getItemPlacement(this._settings, item) === placement && isVisible[item]
            );
            visibleInPlacement.forEach((item, index) => {
                separatorVisible.set(item, index > 0);
            });
        }

        for (const item of DISPLAY_ITEMS) {
            const metric = this._metrics[item];
            if (!metric)
                continue;

            metric.valueLabel.text = values[item];
            metric.separatorLabel.visible = separatorVisible.get(item) ?? false;
            setLabelColor(metric.titleLabel, metricColors[item][0]);
            setLabelColor(metric.valueLabel, metricColors[item][1]);

            if (item === 'download' || item === 'upload')
                this._applyNetworkValueWidth(item);

            if (isVisible[item]) {
                setIndicatorVisible(metric.indicator, true);
                visibleCount++;
            } else {
                setIndicatorVisible(metric.indicator, false);
            }
        }

        setIndicatorVisible(this._fallback?.indicator, visibleCount === 0);
    }

    _update() {
        if (!this._metrics || !this._settings)
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

            this._renderMetrics(values, colors, isVisible);
            this._lastLoggedError = null;
        } catch (error) {
            if (this._metrics) {
                for (const item of DISPLAY_ITEMS)
                    setIndicatorVisible(this._metrics[item]?.indicator, false);
            }
            setIndicatorVisible(this._fallback?.indicator, true);

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

        this._destroyIndicators();
        this._settings = null;
        this._previousCpu = null;
        this._previousNetwork = null;
        this._previousTimestamp = null;
        this._lastLoggedError = null;
        decoder = null;
    }
}
