'use strict';

// A task's free-text `state` (what the project's own files say: "integrated", "ready-for-integration (...)") maps to
// one of the board's three columns. Anything not recognized counts as not being worked on.
const STATUSES = ['todo', 'active', 'done'];

const COMPLETED = ['done', 'integrated', 'merged', 'closed', 'complete', 'completed', 'finished', 'resolved', 'shipped'];
// Closed without the work being done: a project waiting on one of these has to re-plan, not carry on.
const DROPPED = new Set(['wontfix', "won't-fix", 'cancelled', 'canceled', 'superseded', 'abandoned', 'retired', 'dropped', 'duplicate']);
const DONE = new Set([...COMPLETED, ...DROPPED]);
const ACTIVE = new Set(['claimed', 'in-progress', 'inprogress', 'in', 'working', 'active', 'ready-for-integration', 'ready',
	'review', 'in-review', 'integrating', 'verifying', 'testing', 'started', 'wip', 'doing', 'running']);

function firstWord(state) {
	return String(state || '').trim().toLowerCase().split(/[\s,;:(]+/)[0].replace(/[`*_]/g, '');
}

function deriveStatus(state) {
	const first = firstWord(state);
	if (DONE.has(first)) {
		return 'done';
	}
	if (ACTIVE.has(first)) {
		return 'active';
	}
	return 'todo';
}

// How a task in the Complete column ended: "completed", or "dropped" (won't fix, superseded, ...); null while open.
function resolutionOf(task) {
	if (task.status !== 'done') {
		return null;
	}
	return DROPPED.has(firstWord(task.state)) ? 'dropped' : 'completed';
}

module.exports = { deriveStatus, resolutionOf, firstWord, STATUSES };
