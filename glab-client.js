// SPDX-FileCopyrightText: 2026 Fernando Bouchet
// SPDX-License-Identifier: GPL-2.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DEFAULT_TIMEOUT_SECONDS = 30;

const ALLOWED_ENDPOINTS = [
    /^\/user$/,
    /^\/projects$/,
    /^\/projects\/\d+$/,
    /^\/projects\/\d+\/events$/,
    /^\/projects\/\d+\/repository\/commits$/,
    /^\/projects\/\d+\/merge_requests$/,
    /^\/projects\/\d+\/pipelines$/,
];

export class GlabError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'GlabError';
        this.code = code;
    }
}

export function normalizeHostname(value, translate = message => message) {
    let hostname = value.trim().toLowerCase();

    if (/^https?:\/\//.test(hostname))
        hostname = hostname.replace(/^https?:\/\//, '').split('/')[0];
    else if (hostname.includes('://'))
        throw new GlabError(
            'invalid-host',
            translate('The GitLab hostname is invalid')
        );

    hostname = hostname.replace(/\/+$/, '');
    if (!/^[a-z0-9.-]+(?::\d+)?$/.test(hostname))
        throw new GlabError(
            'invalid-host',
            translate('The GitLab hostname is invalid')
        );

    return hostname;
}

function assertProjectId(projectId, translate) {
    const value = String(projectId);
    if (!/^\d+$/.test(value))
        throw new GlabError(
            'invalid-project',
            translate('The project ID is invalid')
        );
    return value;
}

function encodeQuery(parameters) {
    return Object.entries(parameters)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) =>
            `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
        .join('&');
}

export class GlabClient {
    constructor({
        timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
        translate = message => message,
    } = {}) {
        this._timeoutSeconds = timeoutSeconds;
        this._translate = translate;
        this._program = GLib.find_program_in_path('glab');
    }

    get installed() {
        this._program = GLib.find_program_in_path('glab');
        return this._program !== null;
    }

    async getVersion(cancellable = null) {
        const result = await this._run(['version'], cancellable);
        return result.stdout.trim().split('\n')[0];
    }

    async checkAuthentication(hostname, cancellable = null) {
        hostname = normalizeHostname(hostname, this._translate);

        try {
            await this._run(
                ['auth', 'status', '--hostname', hostname],
                cancellable,
                {includeErrorOutput: false}
            );
            return true;
        } catch (error) {
            if (error instanceof GlabError && error.code === 'command-failed')
                return false;
            throw error;
        }
    }

    async getCurrentUser(hostname, cancellable = null) {
        const user = await this._get(hostname, '/user', {}, cancellable);
        return {
            id: user.id,
            username: user.username,
            name: user.name,
            webUrl: user.web_url,
        };
    }

    async listProjects(hostname, cancellable = null) {
        const projects = await this._get(hostname, '/projects', {
            membership: true,
            simple: true,
            order_by: 'last_activity_at',
            sort: 'desc',
            per_page: 50,
        }, cancellable);

        return projects.map(project => ({
            id: String(project.id),
            name: project.name,
            pathWithNamespace: project.path_with_namespace,
            webUrl: project.web_url,
            defaultBranch: project.default_branch,
        }));
    }

    async getProjectStatus(hostname, projectId, cancellable = null) {
        const id = assertProjectId(projectId, this._translate);
        const projectPath = `/projects/${id}`;
        const refreshedAt = new Date().toISOString();

        // These calls intentionally run in sequence. ProjectMonitor processes
        // two projects at a time, so no more than two glab processes coexist.
        const project = await this._get(hostname, projectPath, {}, cancellable);
        const events = await this._get(hostname, `${projectPath}/events`, {
            per_page: 10,
        }, cancellable);
        const commits = project.default_branch
            ? await this._get(
                hostname,
                `${projectPath}/repository/commits`,
                {
                    ref_name: project.default_branch,
                    per_page: 1,
                },
                cancellable
            )
            : [];
        const mergeRequests = await this._get(
            hostname,
            `${projectPath}/merge_requests`,
            {
                state: 'opened',
                order_by: 'updated_at',
                sort: 'desc',
                per_page: 10,
            },
            cancellable
        );
        const pipelines = await this._get(hostname, `${projectPath}/pipelines`, {
            per_page: 1,
            order_by: 'id',
            sort: 'desc',
        }, cancellable);

        const recentEvents = events.map(event =>
            normalizeEvent(event, project.web_url));

        return {
            project: {
                id,
                name: project.name,
                pathWithNamespace: project.path_with_namespace,
                webUrl: project.web_url,
                defaultBranch: project.default_branch,
            },
            latestCommit: normalizeCommit(commits[0]),
            latestDefaultBranchPush: project.default_branch
                ? recentEvents.find(event =>
                    event.ref === project.default_branch) ?? null
                : null,
            mergeRequests: mergeRequests.map(normalizeMergeRequest),
            latestPipeline: normalizePipeline(pipelines[0]),
            refreshedAt,
        };
    }

    async _get(hostname, path, query, cancellable) {
        hostname = normalizeHostname(hostname, this._translate);

        if (!ALLOWED_ENDPOINTS.some(pattern => pattern.test(path)))
            throw new GlabError(
                'endpoint-denied',
                this._translate('GitLab endpoint is not allowed')
            );

        const queryString = encodeQuery(query);
        const endpointPath = path.replace(/^\//, '');
        const endpoint = queryString
            ? `${endpointPath}?${queryString}`
            : endpointPath;
        const result = await this._run([
            'api',
            '--hostname',
            hostname,
            '--method',
            'GET',
            endpoint,
        ], cancellable);

        try {
            return JSON.parse(result.stdout);
        } catch {
            throw new GlabError(
                'invalid-response',
                this._translate('GitLab CLI returned an invalid response')
            );
        }
    }

    _run(args, cancellable = null, {includeErrorOutput = true} = {}) {
        if (!this.installed)
            throw new GlabError(
                'not-installed',
                this._translate('GitLab CLI is not installed')
            );

        const commandCancellable = cancellable ?? new Gio.Cancellable();
        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.setenv('GLAB_NO_PROMPT', '1', true);
        launcher.setenv('NO_COLOR', '1', true);

        let process;
        try {
            process = launcher.spawnv([this._program, ...args]);
        } catch {
            throw new GlabError(
                'spawn-failed',
                this._translate('Could not run GitLab CLI')
            );
        }

        return new Promise((resolve, reject) => {
            let timeoutId = GLib.timeout_add_seconds(
                GLib.PRIORITY_DEFAULT,
                this._timeoutSeconds,
                () => {
                    timeoutId = 0;
                    commandCancellable.cancel();
                    process.force_exit();
                    reject(new GlabError(
                        'timeout',
                        this._translate('GitLab CLI timed out')
                    ));
                    return GLib.SOURCE_REMOVE;
                }
            );

            process.communicate_utf8_async(
                null,
                commandCancellable,
                (source, result) => {
                    if (timeoutId) {
                        GLib.source_remove(timeoutId);
                        timeoutId = 0;
                    }

                    try {
                        const [, stdout, stderr] =
                            source.communicate_utf8_finish(result);

                        if (!source.get_successful()) {
                            const detail = includeErrorOutput
                                ? sanitizeError(
                                    stderr,
                                    this._translate('[hidden token]')
                                )
                                : '';
                            reject(new GlabError(
                                'command-failed',
                                detail || this._translate(
                                    'GitLab CLI could not complete the request'
                                )
                            ));
                            return;
                        }

                        resolve({stdout, stderr});
                    } catch (error) {
                        if (commandCancellable.is_cancelled()) {
                            reject(new GlabError(
                                'cancelled',
                                this._translate('Request cancelled')
                            ));
                        } else {
                            reject(new GlabError(
                                'command-failed',
                                sanitizeError(
                                    error.message,
                                    this._translate('[hidden token]')
                                )
                            ));
                        }
                    }
                }
            );
        });
    }
}

function sanitizeError(value = '', hiddenToken = '[hidden token]') {
    const firstLine = value.trim().split('\n')[0];
    return firstLine
        .replace(/glpat-[A-Za-z0-9_-]+/g, hiddenToken)
        .slice(0, 240);
}

function normalizeEvent(event, projectWebUrl) {
    if (!event)
        return null;

    const push = event.push_data;
    let targetUrl = null;
    if (push?.commit_to)
        targetUrl = `${projectWebUrl}/-/commit/${push.commit_to}`;
    else if (event.target_type === 'MergeRequest' && event.target_iid)
        targetUrl = `${projectWebUrl}/-/merge_requests/${event.target_iid}`;
    else if (event.target_type === 'Issue' && event.target_iid)
        targetUrl = `${projectWebUrl}/-/issues/${event.target_iid}`;

    return {
        id: String(event.id),
        action: event.action_name,
        title: push?.commit_title ?? event.target_title ?? event.action_name,
        author: event.author?.name ?? event.author_username ?? '',
        ref: push?.ref ?? null,
        createdAt: event.created_at,
        webUrl: targetUrl,
    };
}

function normalizeMergeRequest(mergeRequest) {
    return {
        id: String(mergeRequest.id),
        iid: String(mergeRequest.iid),
        title: mergeRequest.title,
        author: mergeRequest.author?.name ?? '',
        state: mergeRequest.state,
        createdAt: mergeRequest.created_at,
        updatedAt: mergeRequest.updated_at,
        webUrl: mergeRequest.web_url,
    };
}

function normalizeCommit(commit) {
    if (!commit)
        return null;

    return {
        id: String(commit.id),
        shortId: commit.short_id,
        title: commit.title,
        author: commit.author_name ?? '',
        committedAt: commit.committed_date,
        webUrl: commit.web_url,
    };
}

function normalizePipeline(pipeline) {
    if (!pipeline)
        return null;

    return {
        id: String(pipeline.id),
        iid: pipeline.iid ? String(pipeline.iid) : null,
        ref: pipeline.ref,
        status: pipeline.status,
        updatedAt: pipeline.updated_at,
        webUrl: pipeline.web_url,
    };
}
