// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import Soup from 'gi://Soup?version=3.0';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async');

const decoder = new TextDecoder('utf-8');
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_PACKAGE_BYTES = 20 * 1024 * 1024;

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
        return 'Karta przewodowa / fizyczna';

    return 'Inny interfejs';
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

            // Keep actual hardware-backed network interfaces. This excludes
            // common bridges, Docker/veth devices and VPN/tunnel interfaces.
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

    // Preserve the user's order, including temporarily disconnected adapters.
    for (const name of savedPriority) {
        if (!name || name === 'lo' || name.includes('/') || seen.has(name))
            continue;
        priority.push(name);
        seen.add(name);
    }

    // Newly detected cards are appended without changing existing priorities.
    for (const {name} of detected) {
        if (!seen.has(name)) {
            priority.push(name);
            seen.add(name);
        }
    }

    return priority;
}

function isHttpsUrl(value) {
    try {
        const uri = GLib.Uri.parse(value, GLib.UriFlags.NONE);
        return uri.get_scheme()?.toLowerCase() === 'https' && Boolean(uri.get_host());
    } catch {
        return false;
    }
}

function fetchBytes(session, url, maxBytes) {
    return new Promise((resolve, reject) => {
        if (!isHttpsUrl(url)) {
            reject(new Error('Adres musi używać HTTPS.'));
            return;
        }

        const message = Soup.Message.new('GET', url);
        if (!message) {
            reject(new Error('Nie można utworzyć żądania HTTP.'));
            return;
        }

        message.get_request_headers().append('Accept', 'application/json, application/zip, application/octet-stream;q=0.9, */*;q=0.1');

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (source, result) => {
                try {
                    const bytes = source.send_and_read_finish(result);
                    const status = message.get_status();

                    if (status < 200 || status >= 300)
                        throw new Error(`Serwer zwrócił HTTP ${status}.`);

                    const data = bytes.get_data();
                    if (!data)
                        throw new Error('Serwer zwrócił pustą odpowiedź.');
                    if (data.length > maxBytes)
                        throw new Error('Pobrany plik przekracza dozwolony rozmiar.');

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
        throw new Error('Nieprawidłowy format update.json.');

    if (raw.schema !== 1)
        throw new Error('Nieobsługiwana wersja formatu update.json.');

    if (raw.uuid !== uuid)
        throw new Error(`Manifest dotyczy innego rozszerzenia (${raw.uuid ?? 'brak UUID'}).`);

    if (!Number.isInteger(raw.version) || raw.version < 1)
        throw new Error('Manifest ma nieprawidłowy numer wersji.');

    if (typeof raw.version_name !== 'string' || !raw.version_name.trim())
        throw new Error('Manifest nie zawiera poprawnego version_name.');

    if (!Array.isArray(raw.shell_versions) || !raw.shell_versions.includes('46'))
        throw new Error('Ta aktualizacja nie deklaruje obsługi GNOME Shell 46.');

    if (!isHttpsUrl(raw.download_url))
        throw new Error('Adres paczki aktualizacji nie jest poprawnym adresem HTTPS.');

    if (typeof raw.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(raw.sha256))
        throw new Error('Manifest nie zawiera poprawnej sumy SHA-256.');

    return {
        schema: 1,
        uuid: raw.uuid,
        version: raw.version,
        versionName: raw.version_name.trim().slice(0, 100),
        shellVersions: [...raw.shell_versions],
        downloadUrl: raw.download_url,
        sha256: raw.sha256.toLowerCase(),
        changelog: normalizeChangelog(raw.changelog),
    };
}

async function installPackage(bytes, manifest, uuid) {
    const digest = GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, bytes);
    if (!digest || digest.toLowerCase() !== manifest.sha256)
        throw new Error('SHA-256 pobranej paczki nie zgadza się z manifestem. Nic nie zostało zainstalowane.');

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
            throw new Error(detail || `gnome-extensions zakończył się kodem ${proc.get_exit_status()}.`);
        }
    } finally {
        try {
            tempFile.delete(null);
        } catch {
            // A failed cleanup of a random file in /tmp is not an update failure.
        }
    }
}

export default class TinyResourceMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window._settings = settings;
        window.set_default_size(680, 600);
        window.search_enabled = false;

        this._buildNetworkPage(window, settings);
        this._buildUpdatePage(window, settings);
        this._buildAboutPage(window);
    }

    _buildNetworkPage(window, settings) {
        const page = new Adw.PreferencesPage({
            title: 'Network',
            icon_name: 'network-workgroup-symbolic',
        });
        window.add(page);

        const infoGroup = new Adw.PreferencesGroup({
            title: 'Priorytet kart sieciowych',
            description: 'Monitor wybiera pierwszą aktywną kartę od góry. Jeśli żadna z zapisanych kart nie jest aktywna, transfer sieci znika z górnego paska.',
        });
        page.add(infoGroup);

        const group = new Adw.PreferencesGroup({
            title: 'Wykryte karty',
            description: 'Użyj strzałek, aby ustawić kolejność. Zmiana działa od razu.',
        });
        page.add(group);

        const refreshButton = new Gtk.Button({
            icon_name: 'view-refresh-symbolic',
            tooltip_text: 'Wykryj karty ponownie',
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
                    title: 'Nie wykryto fizycznych kart sieciowych',
                    subtitle: 'Kliknij przycisk odświeżania po podłączeniu karty.',
                });
                group.add(row);
                rows.push(row);
                return;
            }

            priority.forEach((name, index) => {
                const details = detectedByName.get(name);
                const subtitle = details
                    ? `${details.kind} • ${details.active ? 'aktywna' : 'nieaktywna'}`
                    : 'Obecnie niewykryta — pozycja zostanie zachowana';

                const row = new Adw.ActionRow({
                    title: `${index + 1}. ${name}`,
                    subtitle,
                });

                const upButton = new Gtk.Button({
                    icon_name: 'go-up-symbolic',
                    tooltip_text: 'Wyższy priorytet',
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
                    tooltip_text: 'Niższy priorytet',
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

            // Persist the detected cards on first open and append newly added
            // hardware later, without reordering the user's existing choices.
            savePriority();
            render();
        };

        refreshButton.connect('clicked', refresh);
        refresh();
    }

    _buildUpdatePage(window, settings) {
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
            title: 'Aktualizacje',
            description: 'Sprawdzenie odbywa się dopiero po kliknięciu. Instalacja wymaga osobnego kliknięcia Update.',
        });
        page.add(versionGroup);

        const currentRow = new Adw.ActionRow({
            title: 'Zainstalowana wersja',
            subtitle: currentVersionName,
        });
        versionGroup.add(currentRow);

        const latestRow = new Adw.ActionRow({
            title: 'Najnowsza wersja',
            subtitle: 'Nie sprawdzono',
        });
        versionGroup.add(latestRow);

        const statusRow = new Adw.ActionRow({
            title: 'Status',
            subtitle: 'Kliknij „Check for updates”.',
        });
        versionGroup.add(statusRow);

        const checkButton = new Gtk.Button({
            label: 'Check for updates',
            valign: Gtk.Align.CENTER,
        });
        checkButton.add_css_class('suggested-action');
        statusRow.add_suffix(checkButton);

        const sourceGroup = new Adw.PreferencesGroup({
            title: 'Źródło aktualizacji',
            description: 'W release z GitHuba workflow ustawia ten adres automatycznie. Przy lokalnej paczce możesz wkleić adres do update.json ręcznie.',
        });
        page.add(sourceGroup);

        const sourceRow = new Adw.EntryRow({
            title: 'Adres update.json (HTTPS)',
            text: settings.get_string('update-manifest-url'),
        });
        sourceGroup.add(sourceRow);
        settings.bind(
            'update-manifest-url',
            sourceRow,
            'text',
            Gio.SettingsBindFlags.DEFAULT
        );

        const changelogGroup = new Adw.PreferencesGroup({
            title: 'Co nowego',
            visible: false,
        });
        page.add(changelogGroup);
        let changelogRows = [];

        const installGroup = new Adw.PreferencesGroup({
            visible: false,
        });
        page.add(installGroup);

        const installRow = new Adw.ActionRow({
            title: 'Nowa wersja jest gotowa do instalacji',
            subtitle: 'Paczka zostanie pobrana i sprawdzona SHA-256.',
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
            sourceRow.sensitive = !value;
        };

        const showError = error => {
            availableManifest = null;
            installGroup.visible = false;
            clearChangelog();
            latestRow.subtitle = 'Nie udało się sprawdzić';
            statusRow.subtitle = error instanceof Error ? error.message : String(error);
        };

        const checkForUpdates = async () => {
            if (busy)
                return;

            const manifestUrl = settings.get_string('update-manifest-url').trim();
            if (!manifestUrl) {
                showError(new Error('Brak adresu update.json. Ustaw źródło aktualizacji poniżej.'));
                return;
            }

            setBusy(true);
            availableManifest = null;
            installGroup.visible = false;
            clearChangelog();
            latestRow.subtitle = 'Sprawdzanie…';
            statusRow.subtitle = 'Łączenie ze źródłem aktualizacji…';

            try {
                const data = await fetchBytes(session, manifestUrl, MAX_MANIFEST_BYTES);
                const text = decoder.decode(data);
                const manifest = validateManifest(JSON.parse(text), this.uuid);

                latestRow.subtitle = manifest.versionName;
                showChangelog(manifest.changelog);

                if (manifest.version > currentVersion) {
                    availableManifest = manifest;
                    statusRow.subtitle = `Dostępna jest nowa wersja ${manifest.versionName}.`;
                    installRow.title = `New version ${manifest.versionName}`;
                    installGroup.visible = true;
                } else if (manifest.version === currentVersion) {
                    statusRow.subtitle = 'Masz najnowszą wersję.';
                    installGroup.visible = false;
                } else {
                    statusRow.subtitle = `Źródło oferuje starszą wersję (${manifest.versionName}); aktualizacja została pominięta.`;
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
            statusRow.subtitle = `Pobieranie ${manifest.versionName}…`;
            updateButton.label = 'Updating…';

            try {
                const packageBytes = await fetchBytes(session, manifest.downloadUrl, MAX_PACKAGE_BYTES);
                statusRow.subtitle = 'Sprawdzanie SHA-256 i instalowanie…';
                await installPackage(packageBytes, manifest, this.uuid);

                availableManifest = null;
                installGroup.visible = false;
                statusRow.subtitle = `Wersja ${manifest.versionName} została zainstalowana. Wyloguj się i zaloguj ponownie, aby GNOME Shell załadował nowy kod.`;
                latestRow.subtitle = `${manifest.versionName} — zainstalowano`;
            } catch (error) {
                statusRow.subtitle = `Aktualizacja nie powiodła się: ${error instanceof Error ? error.message : String(error)}`;
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
            description: 'Lekki monitor CPU, RAM i transferu sieciowego dla górnego paska GNOME Shell.',
        });
        page.add(aboutGroup);

        aboutGroup.add(new Adw.ActionRow({
            title: 'Wersja',
            subtitle: this.metadata['version-name'] ?? String(this.metadata.version ?? '—'),
        }));

        aboutGroup.add(new Adw.ActionRow({
            title: 'GNOME Shell',
            subtitle: '46',
        }));

        aboutGroup.add(new Adw.ActionRow({
            title: 'Licencja',
            subtitle: 'GPL-3.0-or-later',
        }));

        const updateInfoGroup = new Adw.PreferencesGroup({
            title: 'Aktualizacje',
            description: 'Updater pobiera wyłącznie manifest HTTPS i wskazaną przez niego paczkę ZIP. Przed instalacją sprawdza UUID, zgodność z GNOME 46 i SHA-256.',
        });
        page.add(updateInfoGroup);
    }
}
