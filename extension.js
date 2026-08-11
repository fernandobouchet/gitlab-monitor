// SPDX-FileCopyrightText: 2026 Fernando Bouchet
// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {
    Extension,
    gettext as _,
} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {GlabClient} from './glab-client.js';
import {NotificationManager} from './notifications.js';
import {ProjectMonitor} from './project-monitor.js';
import {StateStore} from './state-store.js';

const GitLabIndicator = GObject.registerClass(
class GitLabIndicator extends PanelMenu.Button {
    constructor(extension, onRefresh, settings) {
        super(0.5, _('Monitor for GitLab'));
        this._settings = settings;
        this.add_style_class_name('gitlab-monitor-indicator');

        const icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/git-symbolic.svg`
            ),
            style_class: 'system-status-icon',
        });
        this.add_child(icon);

        const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
        });
        const headerText = new St.BoxLayout({
            x_expand: true,
            orientation: Clutter.Orientation.VERTICAL,
            style_class: 'gitlab-monitor-header-text',
        });
        headerText.add_child(new St.Label({
            text: _('Monitor for GitLab'),
            style_class: 'gitlab-monitor-title',
        }));
        this._statusLabel = new St.Label({
            text: _('Not configured'),
            style_class: 'gitlab-monitor-secondary',
        });
        headerText.add_child(this._statusLabel);
        header.add_child(headerText);
        this._refreshButton = new St.Button({
            style_class: 'button gitlab-monitor-icon-button',
            accessible_name: _('Refresh'),
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
        });
        this._refreshButton.connect('clicked', onRefresh);
        header.add_child(this._refreshButton);
        const preferencesButton = new St.Button({
            style_class: 'button gitlab-monitor-icon-button',
            accessible_name: _('Preferences'),
            y_align: Clutter.ActorAlign.CENTER,
            child: new St.Icon({icon_name: 'preferences-system-symbolic'}),
        });
        preferencesButton.connect('clicked', () => extension.openPreferences());
        header.add_child(preferencesButton);
        this.menu.addMenuItem(header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._projectsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._projectsSection);

        this._branchIcon = Gio.icon_new_for_string(
            `${extension.path}/branch-symbolic.svg`
        );
        this._externalLinkIcon = Gio.icon_new_for_string(
            `${extension.path}/external-link-symbolic.svg`
        );
    }

    setStatus(status) {
        const refreshing = status === 'refreshing';
        this._refreshButton.accessible_name = refreshing
            ? _('Refreshing')
            : _('Refresh');
        this._refreshButton.reactive = !refreshing;
        this._refreshButton.can_focus = !refreshing;

        if (refreshing)
            return;

        const labels = {
            'missing-cli': _('GitLab CLI is not installed'),
            unauthenticated: _('GitLab session is not available'),
            'not-configured': _('No projects configured'),
            ready: _('Updated'),
            error: _('Could not query GitLab'),
            'partial-error': _('Partial update'),
        };
        const label = labels[status] ?? status;
        this._statusLabel.text = status === 'ready'
            ? `${label} · ${formatDateTime(new Date())}`
            : label;
    }

    setProjects(snapshots) {
        this._projectsSection.removeAll();

        for (const snapshot of snapshots)
            this._addProject(snapshot);
    }

    _addProject(snapshot) {
        const {
            project,
            latestCommit,
            mergeRequests,
            latestPipeline,
            error,
        } = snapshot;
        this._projectsSection.addMenuItem(createProjectItem(
            project,
            this._branchIcon,
            this._externalLinkIcon
        ));

        if (error) {
            const detail = error.trim().toLowerCase();
            const message = detail === 'error'
                ? _('Could not update')
                : _('Could not update: %s').format(error);
            this._projectsSection.addMenuItem(createInfoItem(`  ${message}`));
        } else if (
            this._settings.get_boolean('show-latest-commit') && latestCommit
        ) {
            const commitTitle = truncate(latestCommit.title, 28) || _('Untitled');
            const committedAt = formatDateTime(
                new Date(latestCommit.committedAt)
            );
            this._projectsSection.addMenuItem(createLinkItem(
                `  ${commitTitle} · ${latestCommit.shortId} · ${committedAt}`,
                latestCommit.webUrl,
                'gitlab-monitor-secondary',
                this._externalLinkIcon
            ));
        } else if (this._settings.get_boolean('show-latest-commit')) {
            this._projectsSection.addMenuItem(createInfoItem(
                `  ${_('No commits on the default branch')}`
            ));
        }

        if (this._settings.get_boolean('show-pipelines') && latestPipeline) {
            const number = latestPipeline.iid ?? latestPipeline.id;
            this._projectsSection.addMenuItem(createLinkItem(
                _('Pipeline #%s · %s · %s').format(
                    number,
                    latestPipeline.ref ?? '',
                    latestPipeline.status ?? ''
                ),
                latestPipeline.webUrl,
                null,
                this._externalLinkIcon
            ));
        }

        if (this._settings.get_boolean('show-merge-requests')) {
            for (const mergeRequest of mergeRequests.slice(0, 3)) {
                this._projectsSection.addMenuItem(createLinkItem(
                    _('MR !%s · %s').format(
                        mergeRequest.iid,
                        truncate(mergeRequest.title, 42)
                    ),
                    mergeRequest.webUrl,
                    null,
                    this._externalLinkIcon
                ));
            }
        }
    }
});

export default class GitLabMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        const client = new GlabClient({translate: _});
        const stateStore = new StateStore();
        this._notifications = new NotificationManager();

        this._indicator = new GitLabIndicator(
            this,
            () => this._monitor?.refresh(),
            this._settings
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._monitor = new ProjectMonitor({
            client,
            settings: this._settings,
            stateStore,
            onUpdate: snapshots => {
                this._indicator?.setProjects(snapshots);
            },
            onTransition: transition => {
                if (this._isNotificationEnabled(transition.type))
                    this._notifications?.show(transition);
            },
            onStatus: status => {
                this._indicator?.setStatus(status);
            },
        });
        this._monitor.start();
    }

    _isNotificationEnabled(type) {
        const setting = {
            'pipeline-failed': 'notifications-enabled',
            'pipeline-recovered': 'notifications-enabled',
            'merge-request-created': 'merge-request-notifications-enabled',
            'default-branch-pushed': 'default-branch-notifications-enabled',
        }[type];

        return setting ? this._settings.get_boolean(setting) : false;
    }

    disable() {
        this._monitor?.stop();
        this._notifications?.destroy();
        this._indicator?.destroy();

        this._monitor = null;
        this._notifications = null;
        this._indicator = null;
        this._settings = null;
    }
}

function createLinkItem(
    label,
    uri,
    styleClass = null,
    externalLinkIcon = null
) {
    const item = new PopupMenu.PopupMenuItem(label, {
        reactive: Boolean(uri),
    });
    if (styleClass)
        item.add_style_class_name(styleClass);
    if (uri) {
        item.connect('activate', () => openUri(uri));
        addExternalLinkIndicator(item, externalLinkIcon);
    }
    return item;
}

function createProjectItem(project, branchIcon, externalLinkIcon) {
    const item = new PopupMenu.PopupBaseMenuItem({
        reactive: Boolean(project.webUrl),
    });
    item.add_style_class_name('gitlab-monitor-project');
    item.add_child(new St.Label({
        text: project.name,
        style_class: 'gitlab-monitor-project-name',
    }));
    item.add_child(new St.Label({text: ' · '}));
    item.add_child(new St.Icon({
        gicon: branchIcon,
        style_class: 'gitlab-monitor-branch-icon',
    }));
    item.add_child(new St.Label({
        text: ` ${project.defaultBranch ?? _('not defined')}`,
        style_class: 'gitlab-monitor-branch',
    }));
    if (project.webUrl) {
        item.connect('activate', () => openUri(project.webUrl));
        addExternalLinkIndicator(item, externalLinkIcon);
    }
    return item;
}

function addExternalLinkIndicator(item, externalLinkIcon) {
    item.cursor_type = Clutter.CursorType.POINTER;
    item.add_child(new St.Widget({x_expand: true}));
    item.add_child(new St.Icon({
        gicon: externalLinkIcon,
        style_class: 'gitlab-monitor-external-link',
        y_align: Clutter.ActorAlign.CENTER,
    }));
}

function createInfoItem(label) {
    const item = new PopupMenu.PopupMenuItem(label, {reactive: false});
    item.add_style_class_name('gitlab-monitor-secondary');
    return item;
}

function openUri(uri) {
    if (!/^https?:\/\//.test(uri))
        return;

    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (error) {
        console.error(
            _('Monitor for GitLab: could not open the URL: %s')
                .format(error.message)
        );
    }
}

function truncate(value, length) {
    if (!value)
        return '';
    return value.length <= length
        ? value
        : `${value.slice(0, length - 1)}…`;
}

function formatDateTime(value) {
    return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'short',
        timeStyle: 'short',
    }).format(value);
}
