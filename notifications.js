import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

export class NotificationManager {
    constructor() {
        this._source = null;
    }

    show(transition) {
        const content = getNotificationContent(transition);
        if (!content)
            return;

        const notification = new MessageTray.Notification({
            source: this._getSource(),
            title: content.title,
            body: content.body,
            iconName: content.iconName,
            urgency: transition.type === 'pipeline-failed'
                ? MessageTray.Urgency.HIGH
                : MessageTray.Urgency.NORMAL,
        });

        if (content.webUrl) {
            notification.connect('activated', () => {
                openUri(content.webUrl);
            });
        }

        this._source.addNotification(notification);
    }

    destroy() {
        this._source?.destroy();
        this._source = null;
    }

    _getSource() {
        if (this._source)
            return this._source;

        this._source = new MessageTray.Source({
            title: _('GitLab Monitor'),
            iconName: 'system-run-symbolic',
        });
        this._source.connect('destroy', () => {
            this._source = null;
        });
        Main.messageTray.add(this._source);
        return this._source;
    }
}

function getNotificationContent(transition) {
    const project = transition.project.pathWithNamespace ||
        transition.project.name;

    if (transition.type === 'pipeline-failed' ||
        transition.type === 'pipeline-recovered') {
        const pipeline = transition.pipeline;
        return {
            title: transition.type === 'pipeline-failed'
                ? _('Pipeline failed')
                : _('Pipeline recovered'),
            body: [
                project,
                pipeline.ref,
                `Pipeline #${pipeline.iid ?? pipeline.id}`,
            ].filter(Boolean).join(' · '),
            iconName: transition.type === 'pipeline-failed'
                ? 'dialog-error-symbolic'
                : 'emblem-ok-symbolic',
            webUrl: pipeline.webUrl,
        };
    }

    if (transition.type === 'merge-request-created') {
        const mergeRequest = transition.mergeRequest;
        return {
            title: _('New merge request'),
            body: `${project} · !${mergeRequest.iid} · ${mergeRequest.title}`,
            iconName: 'dialog-information-symbolic',
            webUrl: mergeRequest.webUrl,
        };
    }

    if (transition.type === 'default-branch-pushed') {
        return {
            title: _('New change on %s').replace(
                '%s',
                transition.project.defaultBranch
            ),
            body: `${project} · ${transition.change.title}`,
            iconName: 'dialog-information-symbolic',
            webUrl: transition.change.webUrl,
        };
    }

    return null;
}

function openUri(uri) {
    if (!/^https?:\/\//.test(uri))
        return;

    try {
        Gio.AppInfo.launch_default_for_uri(uri, null);
    } catch (error) {
        console.error(
            _('GitLab Monitor: could not open the URL: %s')
                .replace('%s', error.message)
        );
    }
}
