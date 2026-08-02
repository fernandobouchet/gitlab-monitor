import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {GlabClient, normalizeHostname} from './glab-client.js';

const MAX_PROJECTS = 10;

const GitLabMonitorPreferencesPage = GObject.registerClass(
class GitLabMonitorPreferencesPage extends Adw.PreferencesPage {
    constructor(settings) {
        super({
            title: 'GitLab Monitor',
            icon_name: 'system-run-symbolic',
        });

        this._settings = settings;
        this._client = new GlabClient();
        this._projectRows = [];
        this._refreshing = false;

        this._buildConnectionGroup();
        this._buildProjectGroup();
        this._buildBehaviorGroup();
        this._refreshConnection();
    }

    _buildConnectionGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Conexión',
            description: 'La extensión reutiliza la sesión de GitLab CLI y no accede al token.',
        });
        this.add(group);

        this._hostnameRow = new Adw.EntryRow({
            title: 'Hostname de GitLab',
            text: this._settings.get_string('hostname'),
        });
        this._hostnameRow.connect('changed', row => {
            this._settings.set_string('hostname', row.text.trim());
        });
        group.add(this._hostnameRow);

        this._connectionStatus = new Adw.ActionRow({
            title: 'Estado',
            subtitle: 'Comprobando GitLab CLI…',
        });
        group.add(this._connectionStatus);

        const verifyRow = new Adw.ActionRow({
            title: 'Verificar conexión',
            subtitle: 'Comprueba glab y la sesión para este hostname.',
        });
        this._verifyButton = new Gtk.Button({
            label: 'Verificar',
            valign: Gtk.Align.CENTER,
        });
        this._verifyButton.connect('clicked', () => this._refreshConnection());
        verifyRow.add_suffix(this._verifyButton);
        verifyRow.activatable_widget = this._verifyButton;
        group.add(verifyRow);

        const loginRow = new Adw.ActionRow({
            title: 'Comando de autenticación',
            subtitle: 'Copia el comando y ejecútalo en una terminal.',
        });
        const copyButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: 'Copiar comando',
            valign: Gtk.Align.CENTER,
        });
        copyButton.connect('clicked', () => this._copyLoginCommand());
        loginRow.add_suffix(copyButton);
        loginRow.activatable_widget = copyButton;
        group.add(loginRow);
    }

    _buildProjectGroup() {
        this._projectsGroup = new Adw.PreferencesGroup({
            title: 'Proyectos',
            description: `Seleccioná hasta ${MAX_PROJECTS} proyectos.`,
        });
        this.add(this._projectsGroup);

        this._projectsStatus = new Adw.ActionRow({
            title: 'Todavía no se cargaron proyectos',
        });
        this._projectsGroup.add(this._projectsStatus);
        this._projectRows.push(this._projectsStatus);
    }

    _buildBehaviorGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Comportamiento',
        });
        this.add(group);

        const intervalRow = new Adw.SpinRow({
            title: 'Intervalo de actualización',
            subtitle: 'Segundos entre consultas automáticas.',
            adjustment: new Gtk.Adjustment({
                lower: 30,
                upper: 900,
                step_increment: 30,
                page_increment: 60,
                value: this._settings.get_uint('refresh-interval'),
            }),
            numeric: true,
        });
        intervalRow.connect('notify::value', row => {
            this._settings.set_uint('refresh-interval', Math.round(row.value));
        });
        group.add(intervalRow);

        const notificationsRow = new Adw.SwitchRow({
            title: 'Notificaciones de pipelines',
            subtitle: 'Notificar fallos y recuperaciones.',
        });
        this._settings.bind(
            'notifications-enabled',
            notificationsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(notificationsRow);

        const mergeRequestNotificationsRow = new Adw.SwitchRow({
            title: 'Notificaciones de merge requests',
            subtitle: 'Notificar nuevos merge requests.',
        });
        this._settings.bind(
            'merge-request-notifications-enabled',
            mergeRequestNotificationsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(mergeRequestNotificationsRow);

        const defaultBranchNotificationsRow = new Adw.SwitchRow({
            title: 'Notificaciones de la rama principal',
            subtitle: 'Notificar nuevos pushes a la rama predeterminada.',
        });
        this._settings.bind(
            'default-branch-notifications-enabled',
            defaultBranchNotificationsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(defaultBranchNotificationsRow);
    }

    async _refreshConnection() {
        if (this._refreshing)
            return;

        this._refreshing = true;
        this._verifyButton.sensitive = false;
        this._connectionStatus.subtitle = 'Comprobando…';

        try {
            if (!this._client.installed) {
                this._connectionStatus.subtitle =
                    'GitLab CLI (glab) no está instalado.';
                this._showProjectMessage('Instalá glab para cargar proyectos.');
                return;
            }

            const hostname = normalizeHostname(this._hostnameRow.text);
            const authenticated =
                await this._client.checkAuthentication(hostname);
            if (!authenticated) {
                this._connectionStatus.subtitle =
                    `No hay una sesión autenticada para ${hostname}.`;
                this._showProjectMessage('Autenticate con glab y volvé a verificar.');
                return;
            }

            const [version, user, projects] = await Promise.all([
                this._client.getVersion(),
                this._client.getCurrentUser(hostname),
                this._client.listProjects(hostname),
            ]);
            this._connectionStatus.subtitle =
                `${user.name || user.username} · ${version}`;
            this._renderProjects(projects);
        } catch (error) {
            this._connectionStatus.subtitle = error.message;
            this._showProjectMessage('No se pudieron cargar los proyectos.');
        } finally {
            this._verifyButton.sensitive = true;
            this._refreshing = false;
        }
    }

    _renderProjects(projects) {
        this._clearProjectRows();

        if (projects.length === 0) {
            this._showProjectMessage('No se encontraron proyectos accesibles.');
            return;
        }

        const selected = new Set(
            this._settings.get_strv('selected-projects')
        );

        for (const project of projects) {
            const row = new Adw.ActionRow({
                title: project.name,
                subtitle: project.pathWithNamespace,
            });
            const toggle = new Gtk.Switch({
                active: selected.has(project.id),
                valign: Gtk.Align.CENTER,
            });
            row.add_suffix(toggle);
            row.activatable_widget = toggle;

            toggle.connect('notify::active', widget => {
                const current = new Set(
                    this._settings.get_strv('selected-projects')
                );

                if (widget.active) {
                    if (current.size >= MAX_PROJECTS) {
                        widget.active = false;
                        this._projectsGroup.description =
                            `Podés seleccionar hasta ${MAX_PROJECTS} proyectos.`;
                        return;
                    }
                    current.add(project.id);
                } else {
                    current.delete(project.id);
                }

                this._settings.set_strv(
                    'selected-projects',
                    [...current]
                );
                this._projectsGroup.description =
                    `${current.size} de ${MAX_PROJECTS} proyectos seleccionados.`;
            });

            this._projectsGroup.add(row);
            this._projectRows.push(row);
        }

        this._projectsGroup.description =
            `${selected.size} de ${MAX_PROJECTS} proyectos seleccionados.`;
    }

    _showProjectMessage(message) {
        this._clearProjectRows();
        const row = new Adw.ActionRow({title: message});
        this._projectsGroup.add(row);
        this._projectRows.push(row);
    }

    _clearProjectRows() {
        for (const row of this._projectRows)
            this._projectsGroup.remove(row);
        this._projectRows = [];
    }

    _copyLoginCommand() {
        let hostname;
        try {
            hostname = normalizeHostname(this._hostnameRow.text);
        } catch {
            hostname = 'gitlab.com';
        }

        const command =
            `glab auth login --hostname ${hostname} --web --use-keyring`;
        Gdk.Display.get_default().get_clipboard().set(command);
        this._connectionStatus.subtitle =
            'Comando de autenticación copiado.';
    }
});

export default class GitLabMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.search_enabled = true;
        window.add(new GitLabMonitorPreferencesPage(this.getSettings()));
    }
}
