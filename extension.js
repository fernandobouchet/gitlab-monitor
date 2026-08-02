import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {GlabClient} from './glab-client.js';
import {NotificationManager} from './notifications.js';
import {ProjectMonitor} from './project-monitor.js';
import {StateStore} from './state-store.js';

const GitLabIndicator = GObject.registerClass(
class GitLabIndicator extends PanelMenu.Button {
    constructor(extension, onRefresh) {
        super(0.5, 'GitLab Monitor');

        this._extension = extension;
        this._icon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${extension.path}/gitlab-symbolic.svg`
            ),
            style_class: 'system-status-icon',
        });
        this.add_child(this._icon);

        const header = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
        });
        const title = new St.Label({
            text: 'GitLab Monitor',
            x_expand: true,
            style_class: 'gitlab-monitor-title',
        });
        header.add_child(title);
        this._statusLabel = new St.Label({
            text: 'Sin configurar',
            style_class: 'gitlab-monitor-secondary',
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(this._statusLabel);
        this._refreshButton = new St.Button({
            style_class: 'button gitlab-monitor-icon-button',
            accessible_name: 'Actualizar',
            child: new St.Icon({icon_name: 'view-refresh-symbolic'}),
        });
        this._refreshButton.connect('clicked', onRefresh);
        header.add_child(this._refreshButton);
        const preferencesButton = new St.Button({
            style_class: 'button gitlab-monitor-icon-button',
            accessible_name: 'Preferencias',
            child: new St.Icon({icon_name: 'preferences-system-symbolic'}),
        });
        preferencesButton.connect('clicked', () => extension.openPreferences());
        header.add_child(preferencesButton);
        this.menu.addMenuItem(header);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._projectsSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._projectsSection);
    }

    setStatus(status) {
        const refreshing = status === 'refreshing';
        this._refreshButton.accessible_name = refreshing
            ? 'Actualizando'
            : 'Actualizar';
        this._refreshButton.reactive = !refreshing;
        this._refreshButton.can_focus = !refreshing;

        if (refreshing)
            return;

        const labels = {
            'missing-cli': 'GitLab CLI no está instalado',
            unauthenticated: 'Sesión de GitLab no disponible',
            'not-configured': 'Sin proyectos configurados',
            ready: 'Actualizado',
            error: 'No se pudo consultar GitLab',
            'partial-error': 'Actualización parcial',
        };
        const label = labels[status] ?? status;
        this._statusLabel.text = status === 'ready'
            ? `${label} · ${formatDateTime(new Date())}`
            : label;
    }

    setProjects(snapshots) {
        this._projectsSection.removeAll();

        for (const [index, snapshot] of snapshots.entries()) {
            this._addProject(snapshot);
            if (index < snapshots.length - 1) {
                this._projectsSection.addMenuItem(
                    new PopupMenu.PopupSeparatorMenuItem()
                );
            }
        }
    }

    _addProject(snapshot) {
        const {project, latestCommit, mergeRequests, latestPipeline, error} =
            snapshot;
        this._projectsSection.addMenuItem(createLinkItem(
            project.name,
            project.webUrl,
            'gitlab-monitor-project'
        ));

        if (error) {
            const detail = error.trim().toLowerCase();
            const message = detail === 'error'
                ? 'No se pudo actualizar'
                : `No se pudo actualizar: ${error}`;
            this._projectsSection.addMenuItem(createInfoItem(`  ${message}`));
        } else {
            this._projectsSection.addMenuItem(createInfoItem(
                `  Rama principal: ${project.defaultBranch ?? 'Sin definir'}`
            ));

            if (latestCommit) {
                this._projectsSection.addMenuItem(createLinkItem(
                    `  Último commit: ${latestCommit.shortId} · ${truncate(latestCommit.title, 32)}`,
                    latestCommit.webUrl,
                    'gitlab-monitor-secondary'
                ));
                this._projectsSection.addMenuItem(createInfoItem(
                    `  Fecha: ${formatDateTime(new Date(latestCommit.committedAt))}`
                ));
            } else {
                this._projectsSection.addMenuItem(createInfoItem(
                    '  Sin commits en la rama principal'
                ));
            }

            if (latestPipeline) {
                const number = latestPipeline.iid ?? latestPipeline.id;
                this._projectsSection.addMenuItem(createLinkItem(
                    `  Pipeline #${number} · ${latestPipeline.ref ?? ''} · ${latestPipeline.status}`,
                    latestPipeline.webUrl
                ));
            }

            for (const mergeRequest of mergeRequests.slice(0, 3)) {
                this._projectsSection.addMenuItem(createLinkItem(
                    `  MR !${mergeRequest.iid} · ${truncate(mergeRequest.title, 42)}`,
                    mergeRequest.webUrl
                ));
            }
        }
    }
});

export default class GitLabMonitorExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._client = new GlabClient();
        this._stateStore = new StateStore();
        this._notifications = new NotificationManager();
        this._snapshots = [];

        this._indicator = new GitLabIndicator(
            this,
            () => this._monitor?.refresh()
        );
        Main.panel.addToStatusArea(this.uuid, this._indicator);

        this._monitor = new ProjectMonitor({
            client: this._client,
            settings: this._settings,
            stateStore: this._stateStore,
            onUpdate: snapshots => {
                this._snapshots = snapshots;
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
        this._stateStore = null;
        this._client = null;
        this._snapshots = null;
        this._settings = null;
    }
}

function createLinkItem(label, uri, styleClass = null) {
    const item = new PopupMenu.PopupMenuItem(label, {
        reactive: Boolean(uri),
    });
    if (styleClass)
        item.add_style_class_name(styleClass);
    if (uri)
        item.connect('activate', () => openUri(uri));
    return item;
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
        console.error(`GitLab Monitor: no se pudo abrir la URL: ${error.message}`);
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
