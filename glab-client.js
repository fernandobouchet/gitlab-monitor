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
    /^\/projects\/\d+\/pipelines\/\d+$/,
];

export class GlabError extends Error {
    constructor(code, message) {
        super(message);
        this.name = 'GlabError';
        this.code = code;
    }
}

export function normalizeHostname(value) {
    let hostname = value.trim().toLowerCase();

    if (/^https?:\/\//.test(hostname))
        hostname = hostname.replace(/^https?:\/\//, '').split('/')[0];
    else if (hostname.includes('://'))
        throw new GlabError('invalid-host', 'El hostname de GitLab no es válido');

    hostname = hostname.replace(/\/+$/, '');
    if (!/^[a-z0-9.-]+(?::\d+)?$/.test(hostname))
        throw new GlabError('invalid-host', 'El hostname de GitLab no es válido');

    return hostname;
}

function assertProjectId(projectId) {
    const value = String(projectId);
    if (!/^\d+$/.test(value))
        throw new GlabError('invalid-project', 'El ID del proyecto no es válido');
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
    constructor({timeoutSeconds = DEFAULT_TIMEOUT_SECONDS} = {}) {
        this._timeoutSeconds = timeoutSeconds;
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
        hostname = normalizeHostname(hostname);

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
        const id = assertProjectId(projectId);
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
            latestChange: recentEvents[0] ?? null,
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
        hostname = normalizeHostname(hostname);

        if (!ALLOWED_ENDPOINTS.some(pattern => pattern.test(path)))
            throw new GlabError('endpoint-denied', 'Endpoint de GitLab no permitido');

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
                'GitLab CLI devolvió una respuesta inválida'
            );
        }
    }

    _run(args, cancellable = null, {includeErrorOutput = true} = {}) {
        if (!this.installed)
            throw new GlabError('not-installed', 'GitLab CLI no está instalado');

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
            throw new GlabError('spawn-failed', 'No se pudo ejecutar GitLab CLI');
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
                        'GitLab CLI excedió el tiempo de espera'
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
                                ? sanitizeError(stderr)
                                : '';
                            reject(new GlabError(
                                'command-failed',
                                detail || 'GitLab CLI no pudo completar la consulta'
                            ));
                            return;
                        }

                        resolve({stdout, stderr});
                    } catch (error) {
                        if (commandCancellable.is_cancelled()) {
                            reject(new GlabError(
                                'cancelled',
                                'Consulta cancelada'
                            ));
                        } else {
                            reject(new GlabError(
                                'command-failed',
                                sanitizeError(error.message)
                            ));
                        }
                    }
                }
            );
        });
    }
}

function sanitizeError(value = '') {
    const firstLine = value.trim().split('\n')[0];
    return firstLine
        .replace(/glpat-[A-Za-z0-9_-]+/g, '[token oculto]')
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
