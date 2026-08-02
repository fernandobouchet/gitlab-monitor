import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MAX_CONCURRENT_PROJECTS = 2;
const MAX_PROJECTS = 10;

export class ProjectMonitor {
    constructor({
        client,
        settings,
        stateStore,
        onUpdate,
        onTransition,
        onStatus,
    }) {
        this._client = client;
        this._settings = settings;
        this._stateStore = stateStore;
        this._onUpdate = onUpdate;
        this._onTransition = onTransition;
        this._onStatus = onStatus;

        this._timerId = 0;
        this._refreshing = false;
        this._stopped = true;
        this._cancellable = null;
        this._settingsSignals = [];
        this._consecutiveErrors = 0;
    }

    start() {
        this._stopped = false;
        this._settingsSignals.push(
            this._settings.connect('changed::selected-projects',
                () => this.refresh()),
            this._settings.connect('changed::hostname',
                () => this.refresh()),
            this._settings.connect('changed::refresh-interval',
                () => this._scheduleNext())
        );
        this.refresh();
    }

    stop() {
        this._stopped = true;
        this._clearTimer();
        this._cancellable?.cancel();
        this._cancellable = null;

        for (const signal of this._settingsSignals)
            this._settings.disconnect(signal);
        this._settingsSignals = [];
    }

    async refresh() {
        if (this._stopped || this._refreshing)
            return;

        this._clearTimer();

        const projectIds = this._settings
            .get_strv('selected-projects')
            .filter(id => /^\d+$/.test(id))
            .slice(0, MAX_PROJECTS);
        this._stateStore.retain(projectIds);

        if (!this._client.installed) {
            this._onStatus('missing-cli');
            this._onUpdate([]);
            this._scheduleNext();
            return;
        }

        if (projectIds.length === 0) {
            this._onStatus('not-configured');
            this._onUpdate([]);
            this._scheduleNext();
            return;
        }

        this._refreshing = true;
        this._onStatus('refreshing');
        this._cancellable = new Gio.Cancellable();

        const hostname = this._settings.get_string('hostname');
        const statuses = new Map();
        const queue = [...projectIds];
        let errorCount = 0;

        const worker = async () => {
            while (queue.length > 0 && !this._stopped) {
                const projectId = queue.shift();
                try {
                    const snapshot = await this._client.getProjectStatus(
                        hostname,
                        projectId,
                        this._cancellable
                    );
                    const transitions = this._stateStore.update(snapshot);
                    statuses.set(projectId, snapshot);
                    for (const transition of transitions)
                        this._onTransition(transition);
                } catch (error) {
                    if (this._stopped)
                        return;

                    errorCount++;
                    const previous = this._stateStore.get(projectId);
                    statuses.set(projectId, previous
                        ? {...previous, error: error.message}
                        : {
                            project: {
                                id: projectId,
                                name: `Proyecto ${projectId}`,
                                pathWithNamespace: '',
                                webUrl: null,
                                defaultBranch: null,
                            },
                            latestChange: null,
                            latestCommit: null,
                            latestDefaultBranchPush: null,
                            mergeRequests: [],
                            latestPipeline: null,
                            error: error.message,
                        });
                }
            }
        };

        try {
            const authenticated = await this._client.checkAuthentication(
                hostname,
                this._cancellable
            );
            if (!authenticated) {
                this._consecutiveErrors++;
                this._onUpdate(projectIds
                    .map(id => this._stateStore.get(id))
                    .filter(Boolean));
                this._onStatus('unauthenticated');
                return;
            }

            await Promise.all(
                Array.from(
                    {length: Math.min(MAX_CONCURRENT_PROJECTS, queue.length)},
                    () => worker()
                )
            );

            if (this._stopped)
                return;

            const ordered = projectIds
                .map(id => statuses.get(id))
                .filter(Boolean);
            this._onUpdate(ordered);

            if (errorCount === projectIds.length) {
                this._consecutiveErrors++;
                this._onStatus('error');
            } else {
                this._consecutiveErrors = 0;
                this._onStatus(errorCount > 0 ? 'partial-error' : 'ready');
            }
        } catch {
            if (!this._stopped) {
                this._consecutiveErrors++;
                this._onUpdate(projectIds
                    .map(id => this._stateStore.get(id))
                    .filter(Boolean));
                this._onStatus('error');
            }
        } finally {
            this._refreshing = false;
            this._cancellable = null;
            this._scheduleNext();
        }
    }

    _scheduleNext() {
        this._clearTimer();
        if (this._stopped)
            return;

        const configured = this._settings.get_uint('refresh-interval');
        const backoff = this._consecutiveErrors === 0
            ? configured
            : this._consecutiveErrors === 1 ? 120 : 300;

        this._timerId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            backoff,
            () => {
                this._timerId = 0;
                this.refresh();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _clearTimer() {
        if (!this._timerId)
            return;
        GLib.source_remove(this._timerId);
        this._timerId = 0;
    }
}
