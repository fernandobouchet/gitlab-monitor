// SPDX-FileCopyrightText: 2026 Fernando Bouchet
// SPDX-License-Identifier: GPL-2.0-or-later

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Gtk from 'gi://Gtk';

import {
    ExtensionPreferences,
    gettext as _,
} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {GlabClient, normalizeHostname} from './glab-client.js';

const MAX_PROJECTS = 10;

const GitLabMonitorPreferencesPage = GObject.registerClass(
class GitLabMonitorPreferencesPage extends Adw.PreferencesPage {
    constructor(settings) {
        super({
            title: _('Monitor for GitLab'),
            icon_name: 'system-run-symbolic',
        });

        this._settings = settings;
        this._client = new GlabClient({translate: _});
        this._projectRows = [];
        this._refreshing = false;
        this._cancellable = null;

        this._buildConnectionGroup();
        this._buildProjectGroup();
        this._buildBehaviorGroup();
        this._buildDisplayGroup();
        this._refreshConnection();
    }

    _buildConnectionGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Connection'),
            description: _(
                'The extension reuses the GitLab CLI session and does not access the token.'
            ),
        });
        this.add(group);

        this._hostnameRow = new Adw.EntryRow({
            title: _('GitLab hostname'),
            text: this._settings.get_string('hostname'),
        });
        this._hostnameRow.connect('changed', row => {
            this._settings.set_string('hostname', row.text.trim());
        });
        group.add(this._hostnameRow);

        this._connectionStatus = new Adw.ActionRow({
            title: _('Status'),
            subtitle: _('Checking GitLab CLI…'),
        });
        group.add(this._connectionStatus);

        const verifyRow = new Adw.ActionRow({
            title: _('Check connection'),
            subtitle: _('Check glab and the session for this hostname.'),
        });
        this._verifyButton = new Gtk.Button({
            label: _('Check'),
            valign: Gtk.Align.CENTER,
        });
        this._verifyButton.connect('clicked', () => this._refreshConnection());
        verifyRow.add_suffix(this._verifyButton);
        verifyRow.activatable_widget = this._verifyButton;
        group.add(verifyRow);

        const loginRow = new Adw.ActionRow({
            title: _('Authentication command'),
            subtitle: _('Copy the command and run it in a terminal.'),
        });
        const copyButton = new Gtk.Button({
            icon_name: 'edit-copy-symbolic',
            tooltip_text: _('Copy command'),
            valign: Gtk.Align.CENTER,
        });
        copyButton.connect('clicked', () => this._copyLoginCommand());
        loginRow.add_suffix(copyButton);
        loginRow.activatable_widget = copyButton;
        group.add(loginRow);
    }

    _buildProjectGroup() {
        this._projectsGroup = new Adw.PreferencesGroup({
            title: _('Projects'),
            description: _('Select up to %d projects.').format(MAX_PROJECTS),
        });
        this.add(this._projectsGroup);

        this._projectsStatus = new Adw.ActionRow({
            title: _('No projects loaded yet'),
        });
        this._projectsGroup.add(this._projectsStatus);
        this._projectRows.push(this._projectsStatus);
    }

    _buildBehaviorGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Behavior'),
        });
        this.add(group);

        const intervalRow = new Adw.SpinRow({
            title: _('Refresh interval'),
            subtitle: _('Seconds between automatic requests.'),
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
            title: _('Pipeline notifications'),
            subtitle: _('Notify failures and recoveries.'),
        });
        this._settings.bind(
            'notifications-enabled',
            notificationsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(notificationsRow);

        const mergeRequestNotificationsRow = new Adw.SwitchRow({
            title: _('Merge request notifications'),
            subtitle: _('Notify new merge requests.'),
        });
        this._settings.bind(
            'merge-request-notifications-enabled',
            mergeRequestNotificationsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(mergeRequestNotificationsRow);

        const defaultBranchNotificationsRow = new Adw.SwitchRow({
            title: _('Default branch notifications'),
            subtitle: _('Notify new pushes to the default branch.'),
        });
        this._settings.bind(
            'default-branch-notifications-enabled',
            defaultBranchNotificationsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(defaultBranchNotificationsRow);
    }

    _buildDisplayGroup() {
        const group = new Adw.PreferencesGroup({
            title: _('Display'),
        });
        this.add(group);

        const commitRow = new Adw.SwitchRow({
            title: _('Show latest commit'),
            subtitle: _('Show the latest commit for each project.'),
        });
        this._settings.bind(
            'show-latest-commit',
            commitRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(commitRow);

        const pipelinesRow = new Adw.SwitchRow({
            title: _('Show pipelines'),
            subtitle: _('Show the latest pipeline for each project.'),
        });
        this._settings.bind(
            'show-pipelines',
            pipelinesRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(pipelinesRow);

        const mergeRequestsRow = new Adw.SwitchRow({
            title: _('Show merge requests'),
            subtitle: _('Show open merge requests for each project.'),
        });
        this._settings.bind(
            'show-merge-requests',
            mergeRequestsRow,
            'active',
            Gio.SettingsBindFlags.DEFAULT
        );
        group.add(mergeRequestsRow);
    }

    async _refreshConnection() {
        if (this._refreshing)
            return;

        this._refreshing = true;
        this._verifyButton.sensitive = false;
        this._connectionStatus.subtitle = _('Checking…');
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;

        try {
            if (!this._client.installed) {
                this._connectionStatus.subtitle =
                    _('GitLab CLI (glab) is not installed.');
                this._showProjectMessage(_('Install glab to load projects.'));
                return;
            }

            const hostname = normalizeHostname(this._hostnameRow.text, _);
            const authenticated =
                await this._client.checkAuthentication(hostname, cancellable);
            if (!authenticated) {
                this._connectionStatus.subtitle =
                    _('No authenticated session for %s.').format(hostname);
                this._showProjectMessage(
                    _('Authenticate with glab and check again.')
                );
                return;
            }

            const [version, user, projects] = await Promise.all([
                this._client.getVersion(cancellable),
                this._client.getCurrentUser(hostname, cancellable),
                this._client.listProjects(hostname, cancellable),
            ]);
            this._connectionStatus.subtitle =
                `${user.name || user.username} · ${version}`;
            this._renderProjects(projects);
        } catch (error) {
            this._connectionStatus.subtitle = error.message;
            this._showProjectMessage(_('Could not load projects.'));
        } finally {
            if (this._cancellable === cancellable)
                this._cancellable = null;
            this._verifyButton.sensitive = true;
            this._refreshing = false;
        }
    }

    cancel() {
        this._cancellable?.cancel();
    }

    _renderProjects(projects) {
        this._clearProjectRows();

        if (projects.length === 0) {
            this._showProjectMessage(_('No accessible projects found.'));
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
                            _('You can select up to %d projects.')
                                .format(MAX_PROJECTS);
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
                    _('Selected projects: %d of %d')
                        .format(current.size, MAX_PROJECTS);
            });

            this._projectsGroup.add(row);
            this._projectRows.push(row);
        }

        this._projectsGroup.description =
            _('Selected projects: %d of %d')
                .format(selected.size, MAX_PROJECTS);
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
            hostname = normalizeHostname(this._hostnameRow.text, _);
        } catch {
            hostname = 'gitlab.com';
        }

        const command =
            `glab auth login --hostname ${hostname} --web --use-keyring`;
        Gdk.Display.get_default().get_clipboard().set(command);
        this._connectionStatus.subtitle =
            _('Authentication command copied.');
    }
});

export default class GitLabMonitorPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.search_enabled = true;
        const page = new GitLabMonitorPreferencesPage(this.getSettings());
        window.connect('close-request', () => {
            page.cancel();
            return false;
        });
        window.add(page);
    }
}
