// SPDX-FileCopyrightText: 2026 Fernando Bouchet
// SPDX-License-Identifier: GPL-2.0-or-later

export class StateStore {
    constructor() {
        this._snapshots = new Map();
    }

    get(projectId) {
        return this._snapshots.get(String(projectId)) ?? null;
    }

    update(snapshot) {
        const projectId = snapshot.project.id;
        const previous = this._snapshots.get(projectId);
        this._snapshots.set(projectId, snapshot);

        if (!previous)
            return [];

        return [
            ...detectPipelineTransitions(previous, snapshot),
            ...detectMergeRequestTransitions(previous, snapshot),
            ...detectDefaultBranchTransitions(previous, snapshot),
        ];
    }

    retain(projectIds) {
        const retained = new Set(projectIds.map(String));
        for (const projectId of this._snapshots.keys()) {
            if (!retained.has(projectId))
                this._snapshots.delete(projectId);
        }
    }
}

function detectMergeRequestTransitions(previous, current) {
    const previousIds = new Set(
        previous.mergeRequests.map(mergeRequest => mergeRequest.id)
    );
    const refreshedAt = Date.parse(previous.refreshedAt);

    return current.mergeRequests
        .filter(mergeRequest => !previousIds.has(mergeRequest.id))
        .filter(mergeRequest => Date.parse(mergeRequest.createdAt) > refreshedAt)
        .map(mergeRequest => ({
            type: 'merge-request-created',
            project: current.project,
            mergeRequest,
        }));
}

function detectDefaultBranchTransitions(previous, current) {
    const before = previous.latestDefaultBranchPush;
    const after = current.latestDefaultBranchPush;

    if (!after || before?.id === after.id)
        return [];

    return [{
        type: 'default-branch-pushed',
        project: current.project,
        change: after,
    }];
}

function detectPipelineTransitions(previous, current) {
    const before = previous.latestPipeline;
    const after = current.latestPipeline;

    if (!after)
        return [];

    const changed = !before ||
        before.id !== after.id ||
        before.status !== after.status;
    if (!changed)
        return [];

    if (after.status === 'failed') {
        return [{
            type: 'pipeline-failed',
            project: current.project,
            pipeline: after,
        }];
    }

    if (before?.status === 'failed' && after.status === 'success') {
        return [{
            type: 'pipeline-recovered',
            project: current.project,
            pipeline: after,
        }];
    }

    return [];
}
