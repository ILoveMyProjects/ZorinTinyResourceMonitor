// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk?version=4.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const decoder = new TextDecoder('utf-8');
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;
const PROJECT_REPO = 'ILoveMyProjects/ZorinTinyResourceMonitor';
const UPDATE_MANIFEST_URL = `https://raw.githubusercontent.com/${PROJECT_REPO}/master/update.json`;
const RELEASE_URL_PREFIX = `https://github.com/${PROJECT_REPO}/releases/download/`;
const DISPLAY_ITEMS = ['cpu', 'ram', 'download', 'upload'];
const DISPLAY_ITEM_DETAILS = {
    cpu: ['CPU', 'CPU label and percentage'],
    ram: ['RAM', 'RAM label and percentage'],
    download: ['Download', 'Download arrow and current speed'],
    upload: ['Upload', 'Upload arrow and current speed'],
};
const VISIBILITY_KEYS = {
    cpu: 'show-cpu',
    ram: 'show-ram',
    download: 'show-download',
    upload: 'show-upload',
};
const LOCATION_KEYS = {
    cpu: 'cpu-location',
    ram: 'ram-location',
    download: 'download-location',
    upload: 'upload-location',
};
const PLACEMENT_OPTIONS = [
    ['left-near-activities', 'Left · Near Activities'],
    ['left-far-activities', 'Left · Far from Activities'],
    ['center-before-clock', 'Center · Before Date & Time'],
    ['center-after-clock', 'Center · After Date & Time'],
    ['right-before-system', 'Right · Before System Menu'],
    ['right-after-system', 'Right · After System Menu'],
];
const COLOR_KEYS = [
    'cpu-title-color',
    'cpu-value-color',
    'ram-title-color',
    'ram-value-color',
    'download-title-color',
    'download-value-color',
    'upload-title-color',
    'upload-value-color',
];

function readText(path) {
    try {
        const file = Gio.File.new_for_path(path);
        const [, contents] = file.load_contents(null);
        return decoder.decode(contents).trim();
    } catch {
        return null;
    }
}

function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

function describeInterface(name) {
    const base = `/sys/class/net/${name}`;

    if (exists(`${base}/wireless`))
        return 'Wi-Fi';

    if (exists(`${base}/device`))
        return 'Wired / physical adapter';

    return 'Other interface';
}

function isInterfaceActive(name) {
    const base = `/sys/class/net/${name}`;
    const operstate = readText(`${base}/operstate`);
    const carrier = readText(`${base}/carrier`);
    return operstate === 'up' && carrier === '1';
}

function detectPhysicalInterfaces() {
    const directory = Gio.File.new_for_path('/sys/class/net');
    const result = [];
    let enumerator = null;

    try {
        enumerator = directory.enumerate_children(
            'standard::name',
            Gio.FileQueryInfoFlags.NONE,
            null
        );

        while (true) {
            const info = enumerator.next_file(null);
            if (!info)
                break;

            const name = info.get_name();
            if (!name || name === 'lo' || name.includes('/'))
                continue;

            const base = `/sys/class/net/${name}`;

            // Keep hardware-backed interfaces and skip common virtual devices.
            if (!exists(`${base}/device`) && !exists(`${base}/wireless`))
                continue;

            result.push({
                name,
                kind: describeInterface(name),
                active: isInterfaceActive(name),
            });
        }
    } catch (error) {
        console.error(`[Tiny Resource Monitor prefs] ${error}`);
    } finally {
        try {
            enumerator?.close(null);
        } catch {
            // Nothing to clean up if enumeration failed before opening.
        }
    }

    result.sort((a, b) => a.name.localeCompare(b.name));
    return result;
}

function mergePriority(savedPriority, detected) {
    const priority = [];
    const seen = new Set();

    for (const name of savedPriority) {
        if (!name || name === 'lo' || name.includes('/') || seen.has(name))
            continue;
        priority.push(name);
        seen.add(name);
    }

    for (const {name} of detected) {
        if (!seen.has(name)) {
            priority.push(name);
            seen.add(name);
        }
    }

    return priority;
}

function normalizeDisplayOrder(savedOrder) {
    const order = [];
    const seen = new Set();

    for (const item of savedOrder) {
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

function isHttpsUrl(value) {
    try {
        const uri = GLib.Uri.parse(value, GLib.UriFlags.NONE);
        return uri.get_scheme()?.toLowerCase() === 'https' && Boolean(uri.get_host());
    } catch {
        return false;
    }
}

function isOfficialReleaseUrl(value) {
    if (!value.startsWith(RELEASE_URL_PREFIX))
        return false;

    try {
        const uri = GLib.Uri.parse(value, GLib.UriFlags.NONE);
        return uri.get_scheme()?.toLowerCase() === 'https' &&
            uri.get_host()?.toLowerCase() === 'github.com' &&
            !uri.get_userinfo();
    } catch {
        return false;
    }
}

function fetchBytes(session, url, maxBytes) {
    return new Promise((resolve, reject) => {
        if (!isHttpsUrl(url)) {
            reject(new Error('The address must use HTTPS.'));
            return;
        }

        const message = Soup.Message.new('GET', url);
        if (!message) {
            reject(new Error('Could not create the HTTP request.'));
            return;
        }

        message.get_request_headers().append(
            'Accept',
            'application/json, application/zip, application/octet-stream;q=0.9, */*;q=0.1'
        );

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                try {
                    const bytes = source.send_and_read_finish(result);
                    const status = message.get_status();

                    if (status < 200 || status >= 300)
                        throw new Error(`The server returned HTTP ${status}.`);

                    const data = bytes.get_data();
                    if (!data)
                        throw new Error('The server returned an empty response.');
                    if (data.length > maxBytes)
                        throw new Error('The downloaded file is larger than the allowed limit.');

                    resolve(data);
                } catch (error) {
                    reject(error);
                }
            }
        );
    });
}

function normalizeChangelog(value) {
    if (!Array.isArray(value))
        return [];

    return value
        .filter(item => typeof item === 'string')
        .map(item => item.trim())
        .filter(Boolean)
        .slice(0, 20)
        .map(item => item.slice(0, 500));
}

function validateManifest(raw, uuid) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('Invalid update.json format.');

    if (raw.schema !== 1)
        throw new Error('Unsupported update.json schema version.');

    if (raw.uuid !== uuid)
        throw new Error(`The manifest belongs to another extension (${raw.uuid ?? 'missing UUID'}).`);

    if (!Number.isInteger(raw.version) || raw.version < 1)
        throw new Error('The manifest contains an invalid version number.');

    if (typeof raw.version_name !== 'string' || !raw.version_name.trim())
        throw new Error('The manifest does not contain a valid version_name.');

    if (!Array.isArray(raw.shell_versions) || !raw.shell_versions.includes('46'))
        throw new Error('This update does not declare GNOME Shell 46 compatibility.');

    const versionName = raw.version_name.trim().slice(0, 100);
    const expectedDownloadUrl = `${RELEASE_URL_PREFIX}v${versionName}/tiny-resource-monitor@local-v${versionName}.zip`;
    if (typeof raw.download_url !== 'string' ||
        !isOfficialReleaseUrl(raw.download_url) ||
        raw.download_url !== expectedDownloadUrl)
        throw new Error('The update package URL does not match the expected official GitHub Release asset.');

    if (typeof raw.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(raw.sha256))
        throw new Error('The manifest does not contain a valid SHA-256 checksum.');

    return {
        schema: 1,
        uuid: raw.uuid,
        version: raw.version,
        versionName,
        shellVersions: [...raw.shell_versions],
        downloadUrl: raw.download_url,
        sha256: raw.sha256.toLowerCase(),
        changelog: normalizeChangelog(raw.changelog),
    };
}

async function installPackage(bytes, manifest, uuid) {
    const digest = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);
    if (!digest || digest.toLowerCase() !== manifest.sha256)
        throw new Error('The downloaded package failed SHA-256 verification. Nothing was installed.');

    const tempPath = GLib.build_filenamev([
        GLib.get_tmp_dir(),
        `${uuid}-${manifest.version}-${GLib.uuid_string_random()}.zip`,
    ]);
    const tempFile = Gio.File.new_for_path(tempPath);

    try {
        tempFile.replace_contents(
            bytes,
            null,
            false,
            Gio.FileCreateFlags.PRIVATE,
            null
        );

        const proc = Gio.Subprocess.new(
            ['gnome-extensions', 'install', '--force', tempPath],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
        );

        const [, stderr] = await proc.communicate_utf8_async(null, null);
        if (!proc.get_successful()) {
            const detail = stderr?.trim();
            throw new Error(detail || `gnome-extensions exited with code ${proc.get_exit_status()}.`);
        }
    } finally {
        try {
            tempFile.delete(null);
        } catch {
            // A failed cleanup of a random file in /tmp is not an update failure.
        }
    }
}

function rgbaFromString(value) {
    const rgba = new Gdk.RGBA();
    if (!value || !rgba.parse(value))
        rgba.parse('#FFFFFF');
    return rgba;
}

function rgbaToHex(rgba) {
    const channel = value => Math.max(0, Math.min(255, Math.round(value * 255)))
        .toString(16)
        .padStart(2, '0');

    return `#${channel(rgba.red)}${channel(rgba.green)}${channel(rgba.blue)}`.toUpperCase();
}

function addColorRow(group, settings, key, title, subtitle) {
    const row = new Adw.ActionRow({
        title,
        subtitle,
    });

    const dialog = new Gtk.ColorDialog({
        title: `Choose ${title.toLowerCase()}`,
        with_alpha: false,
    });
    const button = new Gtk.ColorDialogButton({
        dialog,
        valign: Gtk.Align.CENTER,
    });
    const resetButton = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: 'Use panel theme color',
        valign: Gtk.Align.CENTER,
    });
    resetButton.add_css_class('flat');

    let syncing = false;
    const sync = () => {
        const configured = settings.get_string(key).trim();
        row.subtitle = configured
            ? `${subtitle} • ${configured.toUpperCase()}`
            : `${subtitle} • Panel theme color`;

        syncing = true;
        button.set_rgba(rgbaFromString(configured));
        syncing = false;
    };

    button.connect('notify::rgba', () => {
        if (syncing)
            return;
        settings.set_string(key, rgbaToHex(button.get_rgba()));
    });

    resetButton.connect('clicked', () => {
        settings.set_string(key, '');
    });

    settings.connect(`changed::${key}`, sync);
    row.add_suffix(button);
    row.add_suffix(resetButton);
    group.add(row);
    sync();
}

export default class TinyResourceMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(760, 700);
        window.search_enabled = false;

        this._buildCustomizePage(window, settings);
        this._buildNetworkPage(window, settings);
        this._buildUpdatePage(window);
        this._buildAboutPage(window);
    }

    _buildCustomizePage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Customize',
            icon_name: 'preferences-system-symbolic',
        });
        window.add(page);

        const networkGroup = new Adw.PreferencesGroup({
            title: 'Network display',
            description: 'This master switch controls network throughput without changing your Download/Upload choices.',
        });
        page.add(networkGroup);

        const networkRow = new Adw.ActionRow({
            title: 'Network',
            subtitle: 'Show network throughput when a prioritized interface is active.',
        });
        const networkSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
        });
        networkRow.add_suffix(networkSwitch);
        networkRow.activatable_widget = networkSwitch;
        networkGroup.add(networkRow);
        settings.bind('show-network', networkSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);

        const placementGroup = new Adw.PreferencesGroup({
            title: 'Independent item placement',
            description: 'Place CPU, RAM, Download and Upload independently. Items that share one slot follow the order configured below.',
        });
        page.add(placementGroup);

        const placementLabels = new Gtk.StringList();
        for (const [, label] of PLACEMENT_OPTIONS)
            placementLabels.append(label);

        for (const item of DISPLAY_ITEMS) {
            const [title] = DISPLAY_ITEM_DETAILS[item];
            const key = LOCATION_KEYS[item];
            const row = new Adw.ComboRow({
                title,
                subtitle: item === 'cpu' || item === 'ram'
                    ? 'Choose exactly where this metric appears in the top panel.'
                    : 'Choose exactly where this network metric appears in the top panel.',
                model: placementLabels,
            });
            placementGroup.add(row);

            const sync = () => {
                const value = settings.get_string(key);
                const index = PLACEMENT_OPTIONS.findIndex(([candidate]) => candidate === value);
                row.selected = index >= 0 ? index : 0;
            };

            row.connect('notify::selected', () => {
                const value = PLACEMENT_OPTIONS[row.selected]?.[0] ?? PLACEMENT_OPTIONS[0][0];
                if (settings.get_string(key) !== value)
                    settings.set_string(key, value);
            });
            settings.connect(`changed::${key}`, sync);
            sync();
        }

        const itemsGroup = new Adw.PreferencesGroup({
            title: 'Visibility and order',
            description: 'Turn items on or off. The order matters only when two or more items use the same placement slot.',
        });
        page.add(itemsGroup);

        let order = normalizeDisplayOrder(settings.get_strv('display-order'));
        let rows = [];
        const itemSwitches = new Map();

        const saveOrder = () => settings.set_strv('display-order', order);

        const clearRows = () => {
            for (const row of rows)
                itemsGroup.remove(row);
            rows = [];
            itemSwitches.clear();
        };

        const updateNetworkSensitivity = () => {
            const enabled = settings.get_boolean('show-network');
            itemSwitches.get('download')?.set_sensitive(enabled);
            itemSwitches.get('upload')?.set_sensitive(enabled);
        };

        const renderItems = () => {
            clearRows();

            order.forEach((item, index) => {
                const [title, subtitle] = DISPLAY_ITEM_DETAILS[item];
                const row = new Adw.ActionRow({
                    title: `${index + 1}. ${title}`,
                    subtitle,
                });

                const visibilitySwitch = new Gtk.Switch({
                    valign: Gtk.Align.CENTER,
                });
                settings.bind(
                    VISIBILITY_KEYS[item],
                    visibilitySwitch,
                    'active',
                    Gio.SettingsBindFlags.DEFAULT
                );
                row.activatable_widget = visibilitySwitch;
                itemSwitches.set(item, visibilitySwitch);

                const upButton = new Gtk.Button({
                    icon_name: 'go-up-symbolic',
                    tooltip_text: 'Move earlier within a shared placement',
                    valign: Gtk.Align.CENTER,
                    sensitive: index > 0,
                });
                upButton.add_css_class('flat');
                upButton.connect('clicked', () => {
                    if (index <= 0)
                        return;
                    [order[index - 1], order[index]] = [order[index], order[index - 1]];
                    saveOrder();
                    renderItems();
                });

                const downButton = new Gtk.Button({
                    icon_name: 'go-down-symbolic',
                    tooltip_text: 'Move later within a shared placement',
                    valign: Gtk.Align.CENTER,
                    sensitive: index < order.length - 1,
                });
                downButton.add_css_class('flat');
                downButton.connect('clicked', () => {
                    if (index >= order.length - 1)
                        return;
                    [order[index], order[index + 1]] = [order[index + 1], order[index]];
                    saveOrder();
                    renderItems();
                });

                row.add_suffix(visibilitySwitch);
                row.add_suffix(upButton);
                row.add_suffix(downButton);
                itemsGroup.add(row);
                rows.push(row);
            });

            updateNetworkSensitivity();
        };

        settings.connect('changed::show-network', updateNetworkSensitivity);
        saveOrder();
        renderItems();

        const widthGroup = new Adw.PreferencesGroup({
            title: 'Network value width',
            description: 'Fixed width prevents the top-bar layout from jumping when transfer speeds change length.',
        });
        page.add(widthGroup);

        const widthModel = new Gtk.StringList();
        widthModel.append('Dynamic');
        widthModel.append('Fixed');

        const addWidthModeRow = (key, title) => {
            const row = new Adw.ComboRow({
                title,
                subtitle: 'Dynamic follows the text. Fixed keeps a stable right-aligned value field.',
                model: widthModel,
            });
            widthGroup.add(row);

            const sync = () => {
                row.selected = settings.get_string(key) === 'dynamic' ? 0 : 1;
            };
            row.connect('notify::selected', () => {
                const value = row.selected === 0 ? 'dynamic' : 'fixed';
                if (settings.get_string(key) !== value)
                    settings.set_string(key, value);
            });
            settings.connect(`changed::${key}`, sync);
            sync();
        };

        addWidthModeRow('download-width-mode', 'Download value');
        addWidthModeRow('upload-width-mode', 'Upload value');

        const colorsGroup = new Adw.PreferencesGroup({
            title: 'Colors',
            description: 'Label colors affect CPU/RAM text and the network arrows. Value colors affect percentages and transfer speeds.',
        });
        page.add(colorsGroup);

        const resetColorsButton = new Gtk.Button({
            label: 'Reset colors',
            tooltip_text: 'Return every text color to the GNOME panel theme',
            valign: Gtk.Align.CENTER,
        });
        resetColorsButton.add_css_class('flat');
        resetColorsButton.connect('clicked', () => {
            for (const key of COLOR_KEYS)
                settings.set_string(key, '');
        });
        colorsGroup.set_header_suffix(resetColorsButton);

        addColorRow(colorsGroup, settings, 'cpu-title-color', 'CPU label', 'Color of “CPU”');
        addColorRow(colorsGroup, settings, 'cpu-value-color', 'CPU value', 'Color of the CPU percentage');
        addColorRow(colorsGroup, settings, 'ram-title-color', 'RAM label', 'Color of “RAM”');
        addColorRow(colorsGroup, settings, 'ram-value-color', 'RAM value', 'Color of the RAM percentage');
        addColorRow(colorsGroup, settings, 'download-title-color', 'Download arrow', 'Color of “↓”');
        addColorRow(colorsGroup, settings, 'download-value-color', 'Download value', 'Color of the download speed');
        addColorRow(colorsGroup, settings, 'upload-title-color', 'Upload arrow', 'Color of “↑”');
        addColorRow(colorsGroup, settings, 'upload-value-color', 'Upload value', 'Color of the upload speed');
    }

    _buildNetworkPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Network',
            icon_name: 'network-workgroup-symbolic',
        });
        window.add(page);

        const infoGroup = new Adw.PreferencesGroup({
            title: 'Interface priority',
            description: 'The monitor uses the first active adapter from the list. If none is active, the network items disappear from the top bar.',
        });
        page.add(infoGroup);

        const group = new Adw.PreferencesGroup({
            title: 'Detected adapters',
            description: 'Use the arrows to set priority. Changes apply immediately.',
        });
        page.add(group);

        const refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Detect adapters again',
            valign: Gtk.Align.CENTER,
        });
        refreshButton.add_css_class('flat');
        group.set_header_suffix(refreshButton);

        let rows = [];
        let detected = [];
        let priority = [];

        const savePriority = () => {
            settings.set_strv('interface-priority', priority);
        };

        const clearRows = () => {
            for (const row of rows)
                group.remove(row);
            rows = [];
        };

        const render = () => {
            clearRows();
            const detectedByName = new Map(detected.map(item => [item.name, item]));

            if (priority.length === 0) {
                const row = new Adw.ActionRow({
                    title: 'No physical network adapters detected',
                    subtitle: 'Connect an adapter and click the refresh button.',
                });
                group.add(row);
                rows.push(row);
                return;
            }

            priority.forEach((name, index) => {
                const details = detectedByName.get(name);
                const subtitle = details
                    ? `${details.kind} • ${details.active ? 'Active' : 'Inactive'}`
                    : 'Not currently detected — saved priority is preserved';

                const row = new Adw.ActionRow({
                    title: `${index + 1}. ${name}`,
                    subtitle,
                });

                const upButton = new Gtk.Button({
                    icon_name: 'go-up-symbolic',
                    tooltip_text: 'Higher priority',
                    valign: Gtk.Align.CENTER,
                    sensitive: index > 0,
                });
                upButton.add_css_class('flat');
                upButton.connect('clicked', () => {
                    if (index <= 0)
                        return;
                    [priority[index - 1], priority[index]] = [priority[index], priority[index - 1]];
                    savePriority();
                    render();
                });

                const downButton = new Gtk.Button({
                    icon_name: 'go-down-symbolic',
                    tooltip_text: 'Lower priority',
                    valign: Gtk.Align.CENTER,
                    sensitive: index < priority.length - 1,
                });
                downButton.add_css_class('flat');
                downButton.connect('clicked', () => {
                    if (index >= priority.length - 1)
                        return;
                    [priority[index], priority[index + 1]] = [priority[index + 1], priority[index]];
                    savePriority();
                    render();
                });

                row.add_suffix(upButton);
                row.add_suffix(downButton);
                group.add(row);
                rows.push(row);
            });
        };

        const refresh = () => {
            detected = detectPhysicalInterfaces();
            priority = mergePriority(settings.get_strv('interface-priority'), detected);
            savePriority();
            render();
        };

        refreshButton.connect('clicked', refresh);
        refresh();
    }

    _buildUpdatePage(window) {
        const page = new Adw.PreferencesPage({
            title: 'Update',
            icon_name: 'software-update-available-symbolic',
        });
        window.add(page);

        const currentVersion = Number.isInteger(this.metadata.version)
            ? this.metadata.version
            : 0;
        const currentVersionName = this.metadata['version-name'] ?? String(currentVersion);

        const versionGroup = new Adw.PreferencesGroup({
            title: 'Updates',
            description: 'Nothing is downloaded until you click Check for updates. Installing a package requires a separate Update click.',
        });
        page.add(versionGroup);

        const currentRow = new Adw.ActionRow({
            title: 'Installed version',
            subtitle: currentVersionName,
        });
        versionGroup.add(currentRow);

        const latestRow = new Adw.ActionRow({
            title: 'Latest version',
            subtitle: 'Not checked',
        });
        versionGroup.add(latestRow);

        const statusRow = new Adw.ActionRow({
            title: 'Status',
            subtitle: 'Click “Check for updates”.',
        });
        versionGroup.add(statusRow);

        const checkButton = new Gtk.Button({
            label: 'Check for updates',
            valign: Gtk.Align.CENTER,
        });
        checkButton.add_css_class('suggested-action');
        statusRow.add_suffix(checkButton);

        const sourceGroup = new Adw.PreferencesGroup({
            title: 'Update source',
            description: 'The update source is fixed to the official project repository and cannot be changed in preferences.',
        });
        page.add(sourceGroup);

        const sourceRow = new Adw.ActionRow({
            title: 'Official repository',
            subtitle: `github.com/${PROJECT_REPO}`,
        });
        sourceGroup.add(sourceRow);

        const changelogGroup = new Adw.PreferencesGroup({
            title: 'What’s new',
            visible: false,
        });
        page.add(changelogGroup);
        let changelogRows = [];

        const installGroup = new Adw.PreferencesGroup({
            visible: false,
        });
        page.add(installGroup);

        const installRow = new Adw.ActionRow({
            title: 'A new version is ready to install',
            subtitle: 'The ZIP will be downloaded and verified with SHA-256 first.',
        });
        installGroup.add(installRow);

        const updateButton = new Gtk.Button({
            label: 'Update',
            valign: Gtk.Align.CENTER,
        });
        updateButton.add_css_class('suggested-action');
        installRow.add_suffix(updateButton);

        const session = new Soup.Session({
            timeout: 20,
            user_agent: `Tiny Resource Monitor/${currentVersionName}`,
        });
        let availableManifest = null;
        let busy = false;

        const clearChangelog = () => {
            for (const row of changelogRows)
                changelogGroup.remove(row);
            changelogRows = [];
            changelogGroup.visible = false;
        };

        const showChangelog = changes => {
            clearChangelog();

            if (changes.length === 0)
                return;

            for (const change of changes) {
                const row = new Adw.ActionRow({
                    title: `• ${change}`,
                });
                changelogGroup.add(row);
                changelogRows.push(row);
            }
            changelogGroup.visible = true;
        };

        const setBusy = value => {
            busy = value;
            checkButton.sensitive = !value;
            updateButton.sensitive = !value;
        };

        const showError = error => {
            availableManifest = null;
            installGroup.visible = false;
            clearChangelog();
            latestRow.subtitle = 'Check failed';
            statusRow.subtitle = error instanceof Error ? error.message : String(error);
        };

        const checkForUpdates = async () => {
            if (busy)
                return;

            const manifestUrl = UPDATE_MANIFEST_URL;

            setBusy(true);
            availableManifest = null;
            installGroup.visible = false;
            clearChangelog();
            latestRow.subtitle = 'Checking…';
            statusRow.subtitle = 'Connecting to the update source…';

            try {
                const data = await fetchBytes(session, manifestUrl, MAX_MANIFEST_BYTES);
                const text = decoder.decode(data);
                const manifest = validateManifest(JSON.parse(text), this.uuid);

                latestRow.subtitle = manifest.versionName;
                showChangelog(manifest.changelog);

                if (manifest.version > currentVersion) {
                    availableManifest = manifest;
                    statusRow.subtitle = `New version ${manifest.versionName} is available.`;
                    installRow.title = `New version ${manifest.versionName}`;
                    installGroup.visible = true;
                } else if (manifest.version === currentVersion) {
                    statusRow.subtitle = 'You are up to date.';
                    installGroup.visible = false;
                } else {
                    statusRow.subtitle = `The source offers an older version (${manifest.versionName}); no update was installed.`;
                    installGroup.visible = false;
                }
            } catch (error) {
                showError(error);
            } finally {
                setBusy(false);
            }
        };

        const performUpdate = async () => {
            if (busy || !availableManifest)
                return;

            const manifest = availableManifest;
            setBusy(true);
            statusRow.subtitle = `Downloading ${manifest.versionName}…`;
            updateButton.label = 'Updating…';

            try {
                const packageBytes = await fetchBytes(session, manifest.downloadUrl, MAX_PACKAGE_BYTES);
                statusRow.subtitle = 'Verifying SHA-256 and installing…';
                await installPackage(packageBytes, manifest, this.uuid);

                availableManifest = null;
                installGroup.visible = false;
                statusRow.subtitle = `Version ${manifest.versionName} was installed. Log out and log back in so GNOME Shell loads the new code.`;
                latestRow.subtitle = `${manifest.versionName} — installed`;
            } catch (error) {
                statusRow.subtitle = `Update failed: ${error instanceof Error ? error.message : String(error)}`;
            } finally {
                updateButton.label = 'Update';
                setBusy(false);
            }
        };

        checkButton.connect('clicked', () => {
            checkForUpdates().catch(error => showError(error));
        });

        updateButton.connect('clicked', () => {
            performUpdate().catch(error => showError(error));
        });
    }

    _buildAboutPage(window) {
        const page = new Adw.PreferencesPage({
            title: 'About',
            icon_name: 'help-about-symbolic',
        });
        window.add(page);

        const aboutGroup = new Adw.PreferencesGroup({
            title: 'Tiny Resource Monitor',
            description: 'A lightweight CPU, RAM and network throughput monitor for the GNOME Shell top bar.',
        });
        page.add(aboutGroup);

        aboutGroup.add(new Adw.ActionRow({
            title: 'Version',
            subtitle: this.metadata['version-name'] ?? String(this.metadata.version ?? '—'),
        }));

        aboutGroup.add(new Adw.ActionRow({
            title: 'GNOME Shell',
            subtitle: '46',
        }));

        aboutGroup.add(new Adw.ActionRow({
            title: 'License',
            subtitle: 'GPL-3.0-or-later',
        }));

        const updateInfoGroup = new Adw.PreferencesGroup({
            title: 'Update security',
            description: 'The updater is pinned to the official project manifest and exact GitHub Release asset path. It verifies UUID, GNOME Shell 46 compatibility and SHA-256 before installation.',
        });
        page.add(updateInfoGroup);
    }
}
