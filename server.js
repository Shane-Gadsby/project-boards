#!/usr/bin/env node
// Project Boards: a local task board + hand-offs queue shared by several Claude Code projects.
// No dependencies. Data is flat files: data/projects/<slug>/{project.json, tasks/<id>.json, handoffs/<id>.json,
// media/, events.jsonl}. One process owns the files; every write goes through it.
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { onboardingText } = require('./lib/onboarding');
const { enrolText } = require('./lib/enrol');
const crypto = require('crypto');
const { createAuth } = require('./lib/auth');
const { depsText } = require('./lib/deps-guide');
const { installScript } = require('./lib/install');
const { upgradeText } = require('./lib/upgrade-guide');
const { createUpdater } = require('./lib/updater');
const { createDocs, RAW_TYPES, SANDBOX_CSP } = require('./lib/docs');
const { deriveStatus, resolutionOf, firstWord, STATUSES } = require('./lib/status');

const VERSION = '1.10.0';
const ROOT = __dirname;
const PORT = Number(process.env.PB_PORT || 4780);
const HOST = process.env.PB_HOST || '0.0.0.0';
// Where clients (the machines running Claude sessions) see this folder, for the paths the onboarding page prints.
const CLIENT_ROOT = process.env.PB_CLIENT_ROOT || ROOT;
const DATA = process.env.PB_DATA || path.join(ROOT, 'data');
// A sub-path this server also answers on, as /projects. Requests under it and at the root both work, each with its own links.
const BASE_PATH = cleanBasePath(process.env.PB_BASE_PATH);
if (process.env.PB_BASE_PATH && !BASE_PATH && process.env.PB_BASE_PATH.replace(/\/+/g, '')) {
	throw new Error(`PB_BASE_PATH is not a path: ${process.env.PB_BASE_PATH}`);
}
const PUBLIC = path.join(ROOT, 'public');
const PROJECTS_DIR = path.join(DATA, 'projects');
const MAX_BODY = 200 * 1024 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const HANDOFF_KINDS = ['choice', 'text', 'look', 'steps', 'info', 'message'];
const STEP_STATES = ['good', 'blocked', 'work'];

fs.mkdirSync(PROJECTS_DIR, { recursive: true });

const auth = createAuth({ dataDir: DATA, writeJson: (...a) => writeJson(...a), envMode: process.env.PB_AUTH });
const docs = createDocs({ dataDir: DATA, projectDir: (s) => projectDir(s), writeJson: (...a) => writeJson(...a), readJson: (f) => readJson(f),
	logEvent: (...a) => logEvent(...a), httpError: (...a) => httpError(...a), now: () => now(), slugify: (t) => slugify(t), idRe: ID_RE });

// The command line is served from here (GET /pb, /api/pb, /install), so it is read fresh whenever bin/pb changes:
// a new pb is published by saving the file, without a restart.
const PB_FILE = path.join(ROOT, 'bin', 'pb');
let cli = { mtime: -1 };
function cliInfo() {
	let st;
	try {
		st = fs.statSync(PB_FILE);
	} catch {
		return null;
	}
	if (st.mtimeMs !== cli.mtime) {
		const buf = fs.readFileSync(PB_FILE);
		const m = /^const VERSION = '([^']+)'/m.exec(buf.toString('utf8'));
		cli = { mtime: st.mtimeMs, buf, version: m ? m[1] : '0', sha256: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length };
	}
	return cli;
}

// What this server stamps into the pb it publishes: the address pb treats as home (and upgrades from), and a LAN address
// if it has one. From the environment, else data/publish.json; with
// neither, the address the download came in on. One source, so no server's copy names another's.
function readPublishFile() {
	try {
		return JSON.parse(fs.readFileSync(path.join(DATA, 'publish.json'), 'utf8'));
	} catch {
		return {}; // optional
	}
}

function publishSettings() {
	const f = readPublishFile();
	return { url: process.env.PB_PUBLIC_URL || f.url || '', lan: process.env.PB_LAN_URL || f.lan || '' };
}

const updater = createUpdater({
	root: ROOT, dataDir: DATA, version: VERSION, httpError: (...a) => httpError(...a),
	mode: () => process.env.PB_UPDATE_MODE || readPublishFile().update || '',
});

function cliFor(req) {
	const c = cliInfo();
	if (!c) {
		return null;
	}
	const p = publishSettings();
	const safe = (v) => (/^[\w:/.\-@[\]]*$/.test(v) ? v : '');
	const text = c.buf.toString('utf8')
		.replace(/^const DEFAULT_SERVER = '.*';$/m, `const DEFAULT_SERVER = '${safe(p.url || baseUrl(req))}';`)
		.replace(/^const DEFAULT_LAN = '.*';$/m, `const DEFAULT_LAN = '${safe(p.lan)}';`);
	const buf = Buffer.from(text);
	return { version: c.version, buf, size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

// ---------------------------------------------------------------------------------------------------------------
// Store

const projects = new Map(); // slug -> { meta, tasks: Map, handoffs: Map, seq }

function now() {
	return new Date().toISOString();
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, '\t') + '\n');
	fs.renameSync(tmp, file);
}

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function projectDir(slug) {
	return path.join(PROJECTS_DIR, slug);
}

function loadRecords(dir) {
	const map = new Map();
	if (!fs.existsSync(dir)) {
		return map;
	}
	for (const name of fs.readdirSync(dir)) {
		if (!name.endsWith('.json')) {
			continue;
		}
		try {
			const rec = readJson(path.join(dir, name));
			map.set(String(rec.id), rec);
		} catch (e) {
			console.error(`skipping unreadable ${path.join(dir, name)}: ${e.message}`);
		}
	}
	return map;
}

function loadAll() {
	for (const slug of fs.readdirSync(PROJECTS_DIR)) {
		const dir = projectDir(slug);
		const metaFile = path.join(dir, 'project.json');
		if (!fs.existsSync(metaFile)) {
			continue;
		}
		const meta = normalizeProject(readJson(metaFile));
		projects.set(slug, {
			meta,
			tasks: loadRecords(path.join(dir, 'tasks')),
			handoffs: loadRecords(path.join(dir, 'handoffs')),
			docs: loadRecords(path.join(dir, 'docs')),
			seq: 0,
		});
	}
}

function normalizeProject(p) {
	return {
		slug: p.slug,
		name: p.name || p.slug,
		path: p.path || '',
		description: p.description || '',
		maxSubagents: clampInt(p.maxSubagents, 0, 10, 0),
		lanes: Array.isArray(p.lanes) ? p.lanes.filter((l) => l && typeof l.id === 'string') : [],
		banner: p.banner || '',
		busy: p.busy && typeof p.busy === 'object' ? p.busy : {},
		...(p.archived ? { archived: p.archived } : {}),
		created: p.created || now(),
		updated: p.updated || now(),
		version: p.version || 1,
	};
}

function protectSystem(proj) {
	if (proj.meta.slug === SYSTEM_SLUG) {
		throw httpError(400, 'this is the board\'s own project, which it needs: it cannot be archived or deleted');
	}
}

function setArchived(proj, archived, actor) {
	protectSystem(proj);
	const m = { ...proj.meta };
	delete m.archived;
	if (archived) {
		m.archived = proj.meta.archived || now();
	}
	m.updated = now();
	m.version += 1;
	proj.meta = m;
	saveProject(proj);
	logEvent(proj, { type: 'project', action: archived ? 'archive' : 'unarchive', actor, record: m });
	wakeWaiters(proj); // nobody should sleep on a project that has stopped
	return projectSummary(proj);
}

// Permanent: the project's folder goes, with its tasks, hand-offs, docs, history and media. Back up first if in doubt.
function deleteProject(proj) {
	protectSystem(proj);
	const { slug } = proj.meta;
	const removed = { tasks: proj.tasks.size, handoffs: proj.handoffs.size, docs: proj.docs.size };
	projects.delete(slug);
	wakeWaiters(proj);
	broadcast(slug, { type: 'project', action: 'delete', id: slug });
	for (const res of sseClients.get(slug) || []) {
		res.end();
	}
	sseClients.delete(slug);
	docs.removeProject(slug);
	if (watchers[slug]) {
		delete watchers[slug];
		saveWatchers([]);
	}
	fs.rmSync(projectDir(slug), { recursive: true, force: true });
	console.log(`${now()} deleted project ${slug}: ${JSON.stringify(removed)}`);
	return { deleted: slug, ...removed };
}

function clampInt(v, lo, hi, dflt) {
	const n = Number.parseInt(v, 10);
	if (!Number.isFinite(n)) {
		return dflt;
	}
	return Math.min(hi, Math.max(lo, n));
}

function saveProject(proj) {
	writeJson(path.join(projectDir(proj.meta.slug), 'project.json'), proj.meta);
}

function saveRecord(proj, kind, rec) {
	writeJson(path.join(projectDir(proj.meta.slug), kind, `${safeFileId(rec.id)}.json`), rec);
}

function deleteRecordFile(proj, kind, id) {
	const f = path.join(projectDir(proj.meta.slug), kind, `${safeFileId(id)}.json`);
	if (fs.existsSync(f)) {
		fs.unlinkSync(f);
	}
}

function safeFileId(id) {
	return String(id).replace(/[^A-Za-z0-9._-]/g, '_');
}

function logEvent(proj, ev) {
	proj.seq += 1;
	const line = { seq: proj.seq, at: now(), ...ev };
	try {
		fs.appendFileSync(path.join(projectDir(proj.meta.slug), 'events.jsonl'), JSON.stringify(line) + '\n');
	} catch (e) {
		console.error(`event log: ${e.message}`);
	}
	broadcast(proj.meta.slug, line);
	if (ev.actor === 'user') {
		if (ev.type === 'handoff' && ev.action === 'answer') {
			wakeAfterQuiet(proj);
		} else {
			wakeWaiters(proj);
		}
	}
	return line;
}

// ---------------------------------------------------------------------------------------------------------------
// Global rules: apply to every project; the user edits them on the page, every session reads them.

const RULES_FILE = path.join(DATA, 'rules.json');
const DEFAULT_RULES = [
	'Visual A/B: anything that can be judged by eye (a rendering difference, a UI change, before/after, option A vs B) goes to the user as a "look" hand-off with screenshots of each variant, cropped to what matters and captioned. Never describe a visual difference only in words, and never ask the user to go and look for themselves.',
	'Over time: anything whose point is how it behaves over time (animation, motion, timing, flicker, transitions, loading, sync) goes to the user as a "look" hand-off with a short video of each variant, long enough to show the behavior, captioned. A screenshot cannot show it.',
];

function loadRules() {
	if (!fs.existsSync(RULES_FILE)) {
		const rules = { rules: DEFAULT_RULES.map((text, i) => ({ id: i + 1, text })), updated: now(), version: 1 };
		writeJson(RULES_FILE, rules);
		return rules;
	}
	return readJson(RULES_FILE);
}

let globalRules = loadRules();

function rulesMarkdown() {
	return globalRules.rules.map((r, i) => `${i + 1}. ${r.text}`).join('\n');
}

// ---------------------------------------------------------------------------------------------------------------
// Live updates: SSE for the page, long-poll waiters for Claude sessions.

const sseClients = new Map(); // slug -> Set(res)
const waiters = new Map(); // slug -> Set({ resolve, timer })

function broadcast(slug, ev) {
	const set = sseClients.get(slug);
	if (!set) {
		return;
	}
	const data = `data: ${JSON.stringify(ev)}\n\n`;
	for (const res of set) {
		res.write(data);
	}
}

// Answers often come in a batch, and a session woken by the first one would act on part of it. So hold the wake until
// the user presses "Tell waiting sessions", or has stopped answering for a while.
const ANSWER_QUIET_MS = Number(process.env.PB_ANSWER_QUIET_MS || 60000);
const quietTimers = new Map(); // slug -> timer

function wakeAfterQuiet(proj) {
	const slug = proj.meta.slug;
	clearTimeout(quietTimers.get(slug));
	quietTimers.set(slug, setTimeout(() => wakeWaiters(proj), ANSWER_QUIET_MS));
}

function waiterCount(slug) {
	const set = waiters.get(slug);
	return set ? set.size : 0;
}

function wakeWaiters(proj) {
	const slug = proj.meta.slug;
	clearTimeout(quietTimers.get(slug));
	quietTimers.delete(slug);
	const n = waiterCount(slug);
	if (n === 0) {
		return 0;
	}
	const set = waiters.get(slug);
	const inbox = inboxOf(proj);
	for (const w of set) {
		clearTimeout(w.timer);
		w.resolve({ woke: true, inbox });
	}
	set.clear();
	broadcast(slug, { type: 'waiters', count: 0 });
	return n;
}

// ---------------------------------------------------------------------------------------------------------------
// Tasks

const TASK_FIELDS = ['title', 'state', 'status', 'owner', 'claimed', 'branch', 'results', 'needs', 'file', 'body',
	'summary', 'tags', 'priority', 'source'];

function nextTaskId(proj) {
	let max = 0;
	for (const id of proj.tasks.keys()) {
		const m = /^(\d+)/.exec(id);
		if (m) {
			max = Math.max(max, Number(m[1]));
		}
	}
	return String(max + 1);
}

function applyTaskFields(rec, body) {
	for (const k of TASK_FIELDS) {
		if (body[k] !== undefined) {
			rec[k] = body[k];
		}
	}
	if (body.status !== undefined) {
		if (!STATUSES.includes(body.status)) {
			throw httpError(400, `status must be one of ${STATUSES.join(', ')}`);
		}
		rec.statusLocked = true;
	} else if (body.state !== undefined && !rec.statusLocked) {
		rec.status = deriveStatus(rec.state);
	}
	if (body.statusLocked === false) {
		rec.statusLocked = false;
		rec.status = deriveStatus(rec.state);
	}
	if (!rec.status) {
		rec.status = deriveStatus(rec.state);
	}
}

function upsertTask(proj, body, actor, { create = true, update = true } = {}) {
	let id = body.id !== undefined && body.id !== null && body.id !== '' ? String(body.id) : null;
	if (id !== null && !ID_RE.test(id)) {
		throw httpError(400, `bad task id "${id}" (letters, digits, . _ -)`);
	}
	const existing = id !== null ? proj.tasks.get(id) : null;
	if (existing) {
		if (!update) {
			throw httpError(409, `task ${id} exists`);
		}
		if (body.ifVersion !== undefined && Number(body.ifVersion) !== existing.version) {
			throw httpError(409, `task ${id} is at version ${existing.version}, not ${body.ifVersion}`);
		}
		const rec = { ...existing };
		applyTaskFields(rec, body);
		if (body.note) {
			rec.log = [...(rec.log || []), { at: now(), by: actor, text: String(body.note) }];
		}
		rec.updated = now();
		rec.version = existing.version + 1;
		proj.tasks.set(id, rec);
		saveRecord(proj, 'tasks', rec);
		logEvent(proj, { type: 'task', action: 'update', actor, id, record: rec });
		return rec;
	}
	if (!create) {
		throw httpError(404, `no task ${id}`);
	}
	if (id === null) {
		id = nextTaskId(proj);
	}
	if (!body.title) {
		throw httpError(400, 'a new task needs a title');
	}
	const rec = { id, title: '', state: 'open', created: now(), updated: now(), version: 1, log: [] };
	applyTaskFields(rec, body);
	if (body.note) {
		rec.log.push({ at: now(), by: actor, text: String(body.note) });
	}
	proj.tasks.set(id, rec);
	saveRecord(proj, 'tasks', rec);
	logEvent(proj, { type: 'task', action: 'create', actor, id, record: rec });
	return rec;
}

// ---------------------------------------------------------------------------------------------------------------
// Hand-offs

const HANDOFF_FIELDS = ['kind', 'title', 'question', 'context', 'choices', 'default', 'media', 'steps', 'lane', 'order',
	'visible', 'source', 'ref', 'tags'];

function validateHandoff(rec) {
	if (!HANDOFF_KINDS.includes(rec.kind)) {
		throw httpError(400, `kind must be one of ${HANDOFF_KINDS.join(', ')}`);
	}
	if (rec.choices !== undefined) {
		if (!Array.isArray(rec.choices)) {
			throw httpError(400, 'choices must be an array of {label, detail} or strings');
		}
		rec.choices = rec.choices.map((c) => (typeof c === 'string' ? { label: c } : { label: String(c.label), detail: c.detail || '' }));
	}
	if (rec.steps !== undefined) {
		if (!Array.isArray(rec.steps)) {
			throw httpError(400, 'steps must be an array of {do, expect} or strings');
		}
		rec.steps = rec.steps.map((s) => (typeof s === 'string' ? { do: s, expect: '' } : { do: String(s.do || ''), expect: String(s.expect || '') }));
	}
	if (rec.media !== undefined) {
		if (!Array.isArray(rec.media)) {
			throw httpError(400, 'media must be an array of {url, kind, caption}');
		}
		rec.media = rec.media.map((m) => ({ url: String(m.url || ''), kind: m.kind === 'video' ? 'video' : 'image', caption: m.caption || '' }));
	}
}

// Global rules 1 and 2: a look shows the user the thing itself. Imported history is exempt.
function requireLookMedia(rec, actor) {
	if (rec.kind === 'look' && actor !== 'import' && !(rec.media || []).some((m) => m.url)) {
		throw httpError(400, 'a "look" hand-off needs at least one screenshot or video (global rules: screenshots for visual A/B, videos for anything over time); upload with pb upload or POST /media');
	}
}

function slugify(text) {
	return String(text || 'item').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'item';
}

function upsertHandoff(proj, body, actor) {
	let id = body.id ? String(body.id) : null;
	if (id !== null && !ID_RE.test(id)) {
		throw httpError(400, `bad hand-off id "${id}"`);
	}
	const existing = id !== null ? proj.handoffs.get(id) : null;
	if (existing) {
		if (body.ifVersion !== undefined && Number(body.ifVersion) !== existing.version) {
			throw httpError(409, `hand-off ${id} is at version ${existing.version}, not ${body.ifVersion}`);
		}
		const rec = { ...existing };
		for (const k of HANDOFF_FIELDS) {
			if (body[k] !== undefined) {
				rec[k] = body[k];
			}
		}
		// Imports may carry the user's earlier answer and Claude's acknowledgement.
		for (const k of ['answer', 'note', 'stepAnswers', 'answeredAt', 'userUpdatedAt', 'ackedAt', 'ackNote']) {
			if (body[k] !== undefined && actor !== 'user') {
				rec[k] = body[k];
			}
		}
		validateHandoff(rec);
		requireLookMedia(rec, actor);
		rec.updated = now();
		rec.version = existing.version + 1;
		proj.handoffs.set(id, rec);
		saveRecord(proj, 'handoffs', rec);
		logEvent(proj, { type: 'handoff', action: 'update', actor, id, record: rec });
		return rec;
	}
	if (id === null) {
		id = slugify(body.title || body.question);
		let n = 2;
		const base = id;
		while (proj.handoffs.has(id)) {
			id = `${base}-${n++}`;
		}
	}
	const rec = { id, kind: 'choice', title: '', question: '', visible: true, order: Date.now(), created: now(), updated: now(), version: 1 };
	for (const k of HANDOFF_FIELDS) {
		if (body[k] !== undefined) {
			rec[k] = body[k];
		}
	}
	for (const k of ['answer', 'note', 'stepAnswers', 'answeredAt', 'userUpdatedAt', 'ackedAt', 'ackNote', 'created']) {
		if (body[k] !== undefined) {
			rec[k] = body[k];
		}
	}
	if (!rec.title && !rec.question) {
		throw httpError(400, 'a hand-off needs a title or a question');
	}
	validateHandoff(rec);
	requireLookMedia(rec, actor);
	if (actor === 'user') {
		rec.userUpdatedAt = now();
	}
	proj.handoffs.set(id, rec);
	saveRecord(proj, 'handoffs', rec);
	logEvent(proj, { type: 'handoff', action: 'create', actor, id, record: rec });
	return rec;
}

// Whether the user has said anything on this hand-off. Clearing the last of it makes it unanswered again.
function hasAnswer(h) {
	const said = (v) => String(v ?? '').trim() !== '';
	return said(h.answer) || said(h.note) || Object.values(h.stepAnswers || {}).some((s) => s && (s.state || said(s.note)));
}

// The user answers from the page: a choice/text answer and note, one step of a hands-on set, or `clear` for all of it.
function answerHandoff(proj, id, body) {
	const existing = proj.handoffs.get(id);
	if (!existing) {
		throw httpError(404, `no hand-off ${id}`);
	}
	const rec = { ...existing };
	if (body.clear) {
		delete rec.answer;
		delete rec.note;
		delete rec.stepAnswers;
	} else if (body.step !== undefined) {
		const idx = Number(body.step);
		if (!Number.isInteger(idx) || idx < 0 || idx >= (rec.steps || []).length) {
			throw httpError(400, 'bad step index');
		}
		const prev = (rec.stepAnswers || {})[idx] || {};
		const st = body.state !== undefined ? body.state : prev.state;
		if (st !== undefined && st !== null && !STEP_STATES.includes(st)) {
			throw httpError(400, `step state must be one of ${STEP_STATES.join(', ')}`);
		}
		rec.stepAnswers = { ...(rec.stepAnswers || {}), [idx]: { state: st || null, note: body.note !== undefined ? String(body.note) : prev.note || '', at: now() } };
		const answered = (rec.steps || []).every((_, i) => rec.stepAnswers[i] && rec.stepAnswers[i].state);
		if (answered) {
			const states = (rec.steps || []).map((_, i) => rec.stepAnswers[i].state);
			rec.answer = states.every((s) => s === 'good') ? 'all good' : 'needs attention';
		} else {
			delete rec.answer;
		}
	} else {
		if (body.answer !== undefined) {
			rec.answer = body.answer === null ? undefined : String(body.answer);
			if (rec.answer === undefined) {
				delete rec.answer;
			}
		}
		if (body.note !== undefined) {
			rec.note = String(body.note);
		}
	}
	// userUpdatedAt moves even when nothing is left: the session may be acting on the old answer, so a withdrawn answer
	// stays in the inbox until it is acknowledged.
	rec.userUpdatedAt = now();
	if (hasAnswer(rec)) {
		rec.answeredAt = rec.userUpdatedAt;
	} else {
		delete rec.answeredAt;
		rec.visible = true; // back to Waiting, even if it was acknowledged with --hide
	}
	rec.updated = rec.userUpdatedAt;
	rec.version = existing.version + 1;
	proj.handoffs.set(id, rec);
	saveRecord(proj, 'handoffs', rec);
	logEvent(proj, { type: 'handoff', action: 'answer', actor: 'user', id, record: rec });
	return rec;
}

function ackHandoff(proj, id, body) {
	const existing = proj.handoffs.get(id);
	if (!existing) {
		throw httpError(404, `no hand-off ${id}`);
	}
	const rec = { ...existing, ackedAt: now(), ackNote: body.note ? String(body.note) : existing.ackNote || '' };
	if (body.hide) {
		rec.visible = false;
	}
	rec.updated = rec.ackedAt;
	rec.version = existing.version + 1;
	proj.handoffs.set(id, rec);
	saveRecord(proj, 'handoffs', rec);
	logEvent(proj, { type: 'handoff', action: 'ack', actor: 'claude', id, record: rec });
	return rec;
}

// What the user has said that Claude has not acknowledged yet.
function inboxOf(proj) {
	const out = [];
	for (const h of proj.handoffs.values()) {
		if (h.userUpdatedAt && (!h.ackedAt || h.userUpdatedAt > h.ackedAt)) {
			out.push(h);
		}
	}
	return out.sort((a, b) => (a.userUpdatedAt < b.userUpdatedAt ? -1 : 1));
}

function handoffState(h) {
	if (h.kind === 'message') {
		return h.ackedAt && h.ackedAt >= (h.userUpdatedAt || '') ? 'acted' : 'answered';
	}
	if (h.kind === 'info') {
		return h.ackedAt ? 'acted' : 'pending';
	}
	if (!h.userUpdatedAt || !hasAnswer(h)) {
		return 'pending';
	}
	if (h.ackedAt && h.ackedAt >= h.userUpdatedAt) {
		return 'acted';
	}
	return 'answered';
}

// ---------------------------------------------------------------------------------------------------------------
// Dependencies: any project or app, registered or not, checks the state of tasks on other projects. A check that
// says who is asking (`from`) is remembered, so the project that owns the task sees who is waiting on it.

const WATCHERS_FILE = path.join(DATA, 'watchers.json');
const WATCH_TTL_MS = 30 * 86400 * 1000; // a watcher that has not checked for this long no longer shows
const WATCH_SAVE_MS = 10 * 60 * 1000; // lastCheck alone is written at most this often
const FROM_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;
let watchers = fs.existsSync(WATCHERS_FILE) ? readJson(WATCHERS_FILE) : {}; // slug -> selector -> from -> {why, until, first, lastCheck}
let watchersSaved = 0;

// "<project>/<task id>", "<project>/tag:<tag>" or "<project>/*" ("#" works in place of "/").
function parseRef(ref) {
	const s = String(ref || '').trim();
	const m = /^([a-z0-9][a-z0-9-]{0,62})[/#](.+)$/.exec(s);
	if (!m) {
		throw httpError(400, `bad ref "${s}": use <project>/<task id>, <project>/tag:<tag> or <project>/*`);
	}
	return { slug: m[1], selector: m[2] };
}

function selectTasks(proj, selector) {
	if (selector === '*') {
		return [...proj.tasks.values()];
	}
	if (selector.startsWith('tag:')) {
		const tag = selector.slice(4);
		return [...proj.tasks.values()].filter((t) => (t.tags || []).includes(tag));
	}
	const t = proj.tasks.get(selector);
	return t ? [t] : [];
}

// until: "done" (completed, not dropped), "closed" (in Complete either way), "active" (started or finished), or a
// state word such as "ready-for-integration" (that state, or completed).
function taskMeets(t, until) {
	const resolution = resolutionOf(t);
	if (until === 'done') {
		return resolution === 'completed';
	}
	if (until === 'closed') {
		return t.status === 'done';
	}
	if (until === 'active') {
		return t.status !== 'todo';
	}
	return resolution === 'completed' || firstWord(t.state) === until;
}

function noteWatcher(slug, selector, from, dep, at) {
	const bySelector = (watchers[slug] ||= {});
	const byFrom = (bySelector[selector] ||= {});
	const prev = byFrom[from];
	const why = dep.why || (prev && prev.why) || '';
	byFrom[from] = { why, until: dep.until, first: prev ? prev.first : at, lastCheck: at };
	return !prev || prev.why !== why || prev.until !== dep.until;
}

function saveWatchers(changedSlugs) {
	writeJson(WATCHERS_FILE, watchers);
	watchersSaved = Date.now();
	for (const slug of changedSlugs) {
		broadcast(slug, { type: 'watchers', record: neededByMap(slug) });
	}
}

function checkDeps(list, from) {
	if (from && !FROM_RE.test(from)) {
		throw httpError(400, 'from: letters, digits, space . _ -, up to 64 characters');
	}
	const at = now();
	const changed = new Set();
	const deps = list.map((d) => {
		const dep = typeof d === 'string' ? { ref: d } : { ...d };
		const out = { ref: String(dep.ref || '').trim(), until: String(dep.until || 'done').trim().toLowerCase(), why: dep.why ? String(dep.why) : '', met: false, dropped: false, tasks: [] };
		let ref;
		try {
			ref = parseRef(out.ref);
		} catch (e) {
			return { ...out, error: e.message };
		}
		const proj = projects.get(ref.slug);
		if (!proj) {
			return { ...out, error: `no project "${ref.slug}"` };
		}
		if (from && noteWatcher(ref.slug, ref.selector, from, out, at)) {
			changed.add(ref.slug);
		}
		out.tasks = selectTasks(proj, ref.selector)
			.sort((x, y) => String(x.id).localeCompare(String(y.id), undefined, { numeric: true }))
			.map((t) => ({ id: t.id, title: t.title, state: t.state, status: t.status, resolution: resolutionOf(t), met: taskMeets(t, out.until),
				owner: t.owner || '', branch: t.branch || '', results: t.results || '', updated: t.updated, version: t.version }));
		out.met = out.tasks.length > 0 && out.tasks.every((t) => t.met);
		out.dropped = out.tasks.some((t) => t.resolution === 'dropped');
		if (!out.tasks.length) {
			if (ref.selector === '*' || ref.selector.startsWith('tag:')) {
				out.note = `no tasks on ${ref.slug} match ${ref.selector} yet`;
			} else {
				out.error = `no task ${ref.selector} on ${ref.slug}`;
			}
		}
		return out;
	});
	if (changed.size || (from && Date.now() - watchersSaved > WATCH_SAVE_MS)) {
		saveWatchers(changed);
	}
	return { checked: at, from: from || null, met: deps.every((d) => d.met), deps };
}

// Per task id of one project: who is waiting on it ({from, ref, why, until, first, lastCheck}). Watchers of a whole
// project ("*") are left out: they are not waiting on any one task.
function neededByMap(slug) {
	const out = {};
	const proj = projects.get(slug);
	if (!proj) {
		return out;
	}
	const cutoff = Date.now() - WATCH_TTL_MS;
	for (const [selector, byFrom] of Object.entries(watchers[slug] || {})) {
		if (selector === '*') {
			continue;
		}
		const list = Object.entries(byFrom).filter(([, w]) => Date.parse(w.lastCheck) >= cutoff).map(([from, w]) => ({ from, ref: `${slug}/${selector}`, ...w }));
		if (!list.length) {
			continue;
		}
		for (const t of selectTasks(proj, selector)) {
			(out[t.id] ||= []).push(...list);
		}
	}
	return out;
}

function forgetWatcher(refs, from) {
	let removed = 0;
	const changed = new Set();
	for (const r of refs) {
		const { slug, selector } = parseRef(r);
		const byFrom = watchers[slug] && watchers[slug][selector];
		if (byFrom && byFrom[from]) {
			delete byFrom[from];
			removed += 1;
			changed.add(slug);
			if (!Object.keys(byFrom).length) {
				delete watchers[slug][selector];
			}
		}
	}
	if (removed) {
		saveWatchers(changed);
	}
	return { removed };
}

function refsFromQuery(url) {
	return url.searchParams.getAll('ref').flatMap((r) => r.split(',')).map((r) => r.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP plumbing

function httpError(status, message) {
	const e = new Error(message);
	e.status = status;
	return e;
}

function send(res, status, body, headers = {}) {
	const isText = typeof body === 'string';
	res.writeHead(status, {
		'Content-Type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		...headers,
	});
	res.end(isText ? body : JSON.stringify(body, null, '\t'));
}

function readBody(req, { raw = false } = {}) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		req.on('data', (c) => {
			size += c.length;
			if (size > MAX_BODY) {
				reject(httpError(413, 'body too large'));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			const buf = Buffer.concat(chunks);
			if (raw) {
				resolve(buf);
				return;
			}
			if (buf.length === 0) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(buf.toString('utf8')));
			} catch (e) {
				reject(httpError(400, `invalid JSON: ${e.message}`));
			}
		});
		req.on('error', reject);
	});
}

const MIME = {
	'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
	'.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
	'.md': 'text/markdown; charset=utf-8', '.ico': 'image/x-icon',
};

// A page, with the sub-path it was reached on put into its asset links and given to its scripts as window.PB_BASE.
function servePage(req, res, file) {
	const base = req.pbBase;
	const html = fs.readFileSync(file, 'utf8')
		.replace('<head>', `<head>\n<script>window.PB_BASE = ${JSON.stringify(base)};</script>`)
		.replace(/(href|src)="\//g, `$1="${base}/`);
	res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
	res.end(html);
}

function serveFile(res, file) {
	if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
		send(res, 404, { error: 'not found' });
		return;
	}
	res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
	fs.createReadStream(file).pipe(res);
}

function getProject(slug) {
	const p = projects.get(slug);
	if (!p) {
		throw httpError(404, `no project "${slug}" (register it: POST /api/projects)`);
	}
	return p;
}

function projectSummary(p) {
	const counts = { todo: 0, active: 0, done: 0, inbox: inboxOf(p).length, waiting: 0, docs: p.docs.size };
	for (const t of p.tasks.values()) {
		counts[t.status] = (counts[t.status] || 0) + 1;
	}
	for (const h of p.handoffs.values()) {
		if (h.visible !== false && handoffState(h) === 'pending' && h.kind !== 'info') {
			counts.waiting += 1;
		}
	}
	return { ...p.meta, counts };
}

// The address the request came in on, so printed links work directly and through a TLS proxy (which sends
// X-Forwarded-Proto: https).
function baseUrl(req) {
	const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() === 'https' ? 'https' : 'http';
	const host = String(req.headers['x-forwarded-host'] || req.headers.host || `${HOST}:${PORT}`).split(',')[0].trim();
	return `${proto}://${host}${req.pbBase || ''}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Docs routes ({p}/docs/...)

function sendRaw(res, rec) {
	const headers = { 'Content-Type': RAW_TYPES[rec.format] || 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
	if (rec.format === 'html' || rec.format === 'svg') {
		headers['Content-Security-Policy'] = SANDBOX_CSP;
	}
	res.writeHead(200, headers);
	res.end(rec.content);
}

async function docsRoute(req, res, url, method, actor, who, proj, id, c) {
	if (!id && method === 'GET') {
		return send(res, 200, docs.list(proj, { tag: url.searchParams.get('tag'), q: url.searchParams.get('q'), unseen: url.searchParams.get('unseen') === '1' }));
	}
	if (!id && method === 'POST') {
		return send(res, 201, docs.upsert(proj, await readBody(req), actor, { update: false }));
	}
	if (id && !c) {
		if (method === 'GET') {
			return send(res, 200, docs.atVersion(proj, id, url.searchParams.get('version')));
		}
		if (method === 'PUT' || method === 'PATCH') {
			return send(res, 200, docs.upsert(proj, { ...(await readBody(req)), id }, actor, { create: method === 'PUT' }));
		}
		if (method === 'DELETE') {
			return send(res, 200, docs.remove(proj, id, actor));
		}
	}
	if (id && c === 'raw' && method === 'GET') {
		return sendRaw(res, docs.atVersion(proj, id, url.searchParams.get('version')));
	}
	if (id && c === 'history' && method === 'GET') {
		return send(res, 200, docs.history(proj, id));
	}
	if (id && c === 'seen' && method === 'POST') {
		return send(res, 200, docs.markSeen(proj, id));
	}
	if (id && c === 'share') {
		needSession(who);
		if (method === 'POST') {
			return send(res, 200, { url: `${baseUrl(req)}/s/${docs.share(proj, id, actor)}` });
		}
		if (method === 'DELETE') {
			return send(res, 200, docs.unshare(proj, id, actor));
		}
	}
	throw httpError(404, `no route ${method} ${url.pathname}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Auth routes (/api/auth/...) and what needs no login

// Reachable without signing in, whatever the mode: the health check, signing in itself, getting pb, and the
// instruction pages (they hold no task data).
function isPublic(parts) {
	if (parts[0] === 'api') {
		return ['health', 'auth', 'pb', 'shared'].includes(parts[1]);
	}
	// "s": a doc's share link (the token is the permission); doc.html and render.js are the page that shows it.
	return ['login', 'login.js', 'style.css', 'pb', 'install', 'install-rhel', 'upgrade', 'enrol', 'enroll', 'onboard', 'deps', 's', 'doc.html', 'doc.js', 'render.js'].includes(parts[0]);
}

// Answers and messages are the user's words; an app token must not be able to put them in Claude's inbox.
function userOnly(actor) {
	if (actor !== 'user') {
		throw httpError(403, 'only the user answers hand-offs and sends messages (from the board page, signed in)');
	}
}

function needSession(who) {
	if (!who || who.kind !== 'session') {
		throw httpError(401, 'sign in on the board page first');
	}
}

async function authRoute(req, res, url, method, who, [sub, arg, act]) {
	if (sub === 'me' && method === 'GET') {
		return send(res, 200, { mode: auth.mode(), passwordSet: auth.passwordSet(), pinned: !!process.env.PB_AUTH, signedIn: !!who,
			kind: who ? who.kind : null, id: who ? who.id : null, name: who ? who.name : null, server: VERSION,
			setPassword: `node ${CLIENT_ROOT}/bin/pb-admin set-password` });
	}
	if (sub === 'login' && method === 'POST') {
		const body = await readBody(req);
		const cookie = await auth.login(req, String(body.password || ''));
		return send(res, 200, { ok: true }, { 'Set-Cookie': cookie });
	}
	if (sub === 'logout' && method === 'POST') {
		return send(res, 200, { ok: true }, { 'Set-Cookie': auth.logout(req, who) });
	}
	if (sub === 'device' && !arg && method === 'POST') {
		const body = await readBody(req);
		return send(res, 200, auth.startDevice(req, body, baseUrl(req)));
	}
	if (sub === 'device' && arg && !act && method === 'GET') {
		needSession(who);
		return send(res, 200, auth.describeDevice(arg));
	}
	if (sub === 'device' && arg && (act === 'approve' || act === 'deny') && method === 'POST') {
		needSession(who);
		return send(res, 200, auth.decideDevice(arg, act === 'approve'));
	}
	if (sub === 'token' && method === 'POST') {
		const body = await readBody(req);
		return send(res, 200, auth.pollDevice(body.device_code));
	}
	if (sub === 'tokens' && !arg && method === 'GET') {
		needSession(who);
		return send(res, 200, auth.listCredentials(who));
	}
	if (sub === 'tokens' && !arg && method === 'POST') {
		needSession(who);
		auth.requireOn();
		const body = await readBody(req);
		return send(res, 201, auth.newToken({ name: body.name || 'token made on the page', client: 'manual', via: 'page', ip: auth.clientIp(req) }));
	}
	if (sub === 'tokens' && arg === 'self' && method === 'DELETE') {
		if (!who || who.kind !== 'token') {
			throw httpError(401, 'send the token to revoke in Authorization: Bearer');
		}
		return send(res, 200, auth.revoke(who.id));
	}
	if (sub === 'tokens' && arg && method === 'DELETE') {
		needSession(who);
		return send(res, 200, auth.revoke(arg));
	}
	if (sub === 'settings' && method === 'PATCH') {
		needSession(who);
		const body = await readBody(req);
		return send(res, 200, { mode: auth.setMode(String(body.mode || ''), (data) => writeJson(auth.adminFile, data)) });
	}
	throw httpError(404, `no route ${method} ${url.pathname}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Routes

function cleanBasePath(p) {
	const c = `/${String(p || '').split('/').filter(Boolean).join('/')}`;
	return c !== '/' && /^(\/[\w.~-]+)+$/.test(c) && !/\/\.\.?(\/|$)/.test(c) ? c : '';
}

function under(pathname, base) {
	return pathname === base || pathname.startsWith(`${base}/`);
}

// Which sub-path a request is on, and its path without it. A proxy that strips the sub-path says which with
// X-Forwarded-Prefix, believed only from loopback like the other forwarded headers; otherwise the path shows it.
function locate(req, url) {
	const sock = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
	const told = sock === '127.0.0.1' || sock === '::1' ? cleanBasePath(req.headers['x-forwarded-prefix']) : '';
	const base = told || (BASE_PATH && under(url.pathname, BASE_PATH) ? BASE_PATH : '');
	req.pbBase = base;
	if (base && under(url.pathname, base)) {
		url.pathname = url.pathname.slice(base.length) || '/';
	}
}

async function route(req, res) {
	const url = new URL(req.url, 'http://x');
	locate(req, url);
	const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
	const method = req.method;
	const who = auth.authenticate(req);
	const authMode = auth.mode();
	const info = cliInfo();
	if (info) {
		res.setHeader('X-PB-CLI-Version', info.version);
	}
	// A browser carries its session cookie to any request, including ones another site makes it send; the page marks
	// its own with X-PB-Actor, which a cross-site form cannot set.
	if (!['GET', 'HEAD'].includes(method) && req.headers.cookie && !req.headers.authorization && !req.headers['x-pb-actor']) {
		throw httpError(403, 'a browser request that changes something must come from the board page (X-PB-Actor header)');
	}
	if (authMode === 'required' && !who && !isPublic(parts)) {
		if (parts[0] === 'api' || parts[0] === 'media' || method !== 'GET') {
			throw httpError(401, `login required: run \`pb login\` (pb ${info ? info.version : ''} or newer; install: curl -fsSL ${baseUrl(req)}/install | sh), or sign in at ${baseUrl(req)}/login`);
		}
		res.writeHead(302, { Location: `${req.pbBase}/login?next=${encodeURIComponent(req.pbBase + url.pathname + url.search)}`, 'Cache-Control': 'no-store' });
		res.end();
		return;
	}
	// Once logins are required, only a signed-in browser is the user; before that the page's header says so.
	const actor = authMode === 'required' ? (who && who.kind === 'session' ? 'user' : 'claude') : req.headers['x-pb-actor'] === 'user' ? 'user' : 'claude';

	if (parts[0] === 'api') {
		const [, a, slug, b, id, c] = parts;
		if (a === 'health' && method === 'GET') {
			return send(res, 200, { ok: true, app: 'project-boards', version: VERSION, port: PORT, projects: projects.size, pid: process.pid, auth: authMode, cli: info ? info.version : null });
		}
		if (a === 'auth') {
			return authRoute(req, res, url, method, who, parts.slice(2));
		}
		// A signed-in browser only: never an app token, and never with logins off, when nobody is signed in.
		if (a === 'update' && !slug) {
			userOnly(actor);
			needSession(who);
			if (method === 'GET') {
				return send(res, 200, await updater.check(url.searchParams.get('force') === '1'));
			}
			if (method === 'POST') {
				const body = await readBody(req);
				return send(res, 202, await updater.start(String(body.version || '')));
			}
		}
		if (a === 'status-of' && method === 'POST') {
			const body = await readBody(req);
			return send(res, 200, { statuses: (Array.isArray(body.states) ? body.states : []).map((s) => deriveStatus(s)) });
		}
		if (a === 'shared' && slug && !b && method === 'GET') {
			return send(res, 200, docs.shared(slug, projects));
		}
		if (a === 'pb' && !slug && method === 'GET') {
			const cli = cliFor(req);
			if (!cli) {
				throw httpError(404, 'bin/pb is missing on the server');
			}
			return send(res, 200, { version: cli.version, sha256: cli.sha256, size: cli.size, url: `${baseUrl(req)}/pb`, install: `curl -fsSL ${baseUrl(req)}/install | sh` });
		}
		if (a === 'rules' && !slug) {
			if (method === 'GET') {
				return send(res, 200, globalRules);
			}
			if (method === 'PUT') {
				const body = await readBody(req);
				const list = Array.isArray(body) ? body : body.rules;
				if (!Array.isArray(list)) {
					throw httpError(400, 'send {rules: ["text", ...]}');
				}
				const texts = list.map((r) => String(typeof r === 'string' ? r : r.text || '').trim()).filter(Boolean);
				globalRules = { rules: texts.map((text, i) => ({ id: i + 1, text })), updated: now(), version: (globalRules.version || 0) + 1, by: actor };
				writeJson(RULES_FILE, globalRules);
				for (const p of projects.values()) {
					broadcast(p.meta.slug, { type: 'rules', record: globalRules });
				}
				return send(res, 200, globalRules);
			}
		}
		if (a === 'format-requests' && !slug) {
			const sys = systemProject();
			if (method === 'GET') {
				return send(res, 200, [...sys.tasks.values()].filter((t) => (t.tags || []).includes('format-request')));
			}
			if (method === 'POST') {
				const body = await readBody(req);
				if (!body.name || !body.description) {
					throw httpError(400, 'name and description required (project, sample optional but wanted)');
				}
				const from = String(body.project || 'unknown project');
				const sample = body.sample ? `\n\n## Sample\n\n\`\`\`\n${String(body.sample).slice(0, 20000)}\n\`\`\`\n` : '';
				const t = upsertTask(sys, {
					title: `Import format "${String(body.name)}" for ${from}`,
					state: 'open',
					source: `format request from ${from}`,
					tags: ['format-request'],
					body: `Requested by a Claude session for project \`${from}\` on ${now()}.\n\n## What is needed\n\n${String(body.description)}${sample}`,
				}, actor);
				upsertHandoff(sys, { kind: 'info', title: `New import format requested: ${body.name}`, question: `${from} asked for a native importer for "${body.name}". It is task #${t.id} on this project.`, source: from }, 'claude');
				return send(res, 201, { task: t.id, project: SYSTEM_SLUG, url: `/#/${SYSTEM_SLUG}/tasks` });
			}
		}
		if (a === 'deps' && !slug) {
			if (method === 'GET') {
				const refs = refsFromQuery(url);
				if (!refs.length) {
					throw httpError(400, 'give one or more ?ref=<project>/<task id>|tag:<tag>|* (repeat ref, or separate with commas)');
				}
				const until = url.searchParams.get('until') || undefined;
				return send(res, 200, checkDeps(refs.map((ref) => ({ ref, until })), url.searchParams.get('from') || ''));
			}
			if (method === 'POST') {
				const body = await readBody(req);
				const list = Array.isArray(body) ? body : body.deps;
				if (!Array.isArray(list) || !list.length) {
					throw httpError(400, 'send {from?, deps: [{ref, until?, why?}, ...]} (or an array)');
				}
				return send(res, 200, checkDeps(list, Array.isArray(body) ? '' : String(body.from || '')));
			}
			if (method === 'DELETE') {
				const from = url.searchParams.get('from') || '';
				const refs = refsFromQuery(url);
				if (!from || !refs.length) {
					throw httpError(400, 'give ?from=<name>&ref=<ref> to stop being listed as waiting on it');
				}
				return send(res, 200, forgetWatcher(refs, from));
			}
		}
		if (a === 'projects' && !slug) {
			if (method === 'GET') {
				return send(res, 200, [...projects.values()].map(projectSummary).sort((x, y) => x.name.localeCompare(y.name)));
			}
			if (method === 'POST') {
				const body = await readBody(req);
				const s = String(body.slug || '');
				if (!SLUG_RE.test(s)) {
					throw httpError(400, 'slug: lower-case letters, digits and -, up to 63 characters');
				}
				if (projects.has(s)) {
					throw httpError(409, `project "${s}" exists`);
				}
				const meta = normalizeProject({ ...body, slug: s, maxSubagents: body.maxSubagents ?? 0 });
				const proj = { meta, tasks: new Map(), handoffs: new Map(), docs: new Map(), seq: 0 };
				projects.set(s, proj);
				saveProject(proj);
				logEvent(proj, { type: 'project', action: 'create', actor, record: meta });
				return send(res, 201, projectSummary(proj));
			}
		}
		if (a === 'projects' && slug) {
			const proj = getProject(slug);
			if (b === 'archive' || b === 'unarchive') {
				if (method !== 'POST' || id) {
					throw httpError(404, `no route ${method} ${url.pathname}`);
				}
				return send(res, 200, setArchived(proj, b === 'archive', actor));
			}
			if (!b && method === 'DELETE') {
				userOnly(actor);
				const body = await readBody(req);
				if (body.confirm !== slug) {
					throw httpError(400, `send {confirm: "${slug}"} to delete this project`);
				}
				return send(res, 200, deleteProject(proj));
			}
			// Archived means read-only, so a session still working in it finds out rather than losing its writes.
			if (proj.meta.archived && method !== 'GET') {
				throw httpError(409, `project "${slug}" is archived: restore it on the board first`);
			}
			if (!b) {
				if (method === 'GET') {
					return send(res, 200, projectSummary(proj));
				}
				if (method === 'PATCH') {
					const body = await readBody(req);
					const m = { ...proj.meta };
					for (const k of ['name', 'path', 'description', 'banner']) {
						if (body[k] !== undefined) {
							m[k] = String(body[k]);
						}
					}
					if (body.maxSubagents !== undefined) {
						m.maxSubagents = clampInt(body.maxSubagents, 0, 10, m.maxSubagents);
					}
					if (body.lanes !== undefined) {
						m.lanes = (Array.isArray(body.lanes) ? body.lanes : []).map((l) => (typeof l === 'string' ? { id: slugify(l), name: l } : { id: slugify(l.id || l.name), name: String(l.name || l.id) }));
					}
					if (body.busy !== undefined) {
						m.busy = { ...m.busy };
						for (const [lane, text] of Object.entries(body.busy || {})) {
							if (text) {
								m.busy[lane] = { text: String(text), since: now() };
							} else {
								delete m.busy[lane];
							}
						}
					}
					m.updated = now();
					m.version += 1;
					proj.meta = m;
					saveProject(proj);
					logEvent(proj, { type: 'project', action: 'update', actor, record: m });
					return send(res, 200, projectSummary(proj));
				}
			}
			if (b === 'tasks') {
				if (!id && method === 'GET') {
					let list = [...proj.tasks.values()];
					const st = url.searchParams.get('status');
					if (st) {
						list = list.filter((t) => t.status === st);
					}
					if (url.searchParams.get('full') !== '1') {
						list = list.map(({ body: _b, log: _l, ...rest }) => rest);
					}
					const needed = neededByMap(slug);
					return send(res, 200, list.map((t) => (needed[t.id] ? { ...t, neededBy: needed[t.id] } : t)));
				}
				if (!id && method === 'POST') {
					return send(res, 201, upsertTask(proj, await readBody(req), actor, { update: false }));
				}
				if (id === 'import' && method === 'POST' && !c) {
					const body = await readBody(req);
					const list = Array.isArray(body) ? body : body.tasks;
					if (!Array.isArray(list)) {
						throw httpError(400, 'send {tasks: [...]} or an array');
					}
					const out = { created: 0, updated: 0, unchanged: 0, errors: [] };
					for (const t of list) {
						try {
							const before = t.id !== undefined ? proj.tasks.get(String(t.id)) : null;
							if (before && TASK_FIELDS.every((k) => t[k] === undefined || JSON.stringify(t[k]) === JSON.stringify(before[k]))) {
								out.unchanged += 1;
								continue;
							}
							upsertTask(proj, t, actor);
							out[before ? 'updated' : 'created'] += 1;
						} catch (e) {
							out.errors.push({ id: t.id, error: e.message });
						}
					}
					return send(res, 200, out);
				}
				if (id) {
					const t = proj.tasks.get(id);
					if (method === 'GET') {
						if (!t) {
							throw httpError(404, `no task ${id}`);
						}
						const needed = neededByMap(slug)[id];
						return send(res, 200, needed ? { ...t, neededBy: needed } : t);
					}
					if (method === 'PATCH' || method === 'PUT') {
						return send(res, 200, upsertTask(proj, { ...(await readBody(req)), id }, actor, { create: method === 'PUT' }));
					}
					if (method === 'DELETE') {
						if (!t) {
							throw httpError(404, `no task ${id}`);
						}
						proj.tasks.delete(id);
						deleteRecordFile(proj, 'tasks', id);
						logEvent(proj, { type: 'task', action: 'delete', actor, id });
						return send(res, 200, { deleted: id });
					}
				}
			}
			if (b === 'handoffs') {
				if (!id && method === 'GET') {
					let list = [...proj.handoffs.values()].map((h) => ({ ...h, state: handoffState(h) }));
					const st = url.searchParams.get('state');
					if (st) {
						list = list.filter((h) => h.state === st);
					}
					return send(res, 200, list.sort((x, y) => (x.order || 0) - (y.order || 0)));
				}
				if (!id && method === 'POST') {
					return send(res, 201, upsertHandoff(proj, await readBody(req), actor));
				}
				if (id === 'import' && method === 'POST' && !c) {
					const body = await readBody(req);
					const list = Array.isArray(body) ? body : body.handoffs;
					if (!Array.isArray(list)) {
						throw httpError(400, 'send {handoffs: [...]} or an array');
					}
					const out = { written: 0, errors: [] };
					for (const h of list) {
						try {
							upsertHandoff(proj, h, 'import');
							out.written += 1;
						} catch (e) {
							out.errors.push({ id: h.id, error: e.message });
						}
					}
					return send(res, 200, out);
				}
				if (id && !c) {
					const h = proj.handoffs.get(id);
					if (method === 'GET') {
						if (!h) {
							throw httpError(404, `no hand-off ${id}`);
						}
						return send(res, 200, { ...h, state: handoffState(h) });
					}
					if (method === 'PATCH') {
						if (!h) {
							throw httpError(404, `no hand-off ${id}`);
						}
						return send(res, 200, upsertHandoff(proj, { ...(await readBody(req)), id }, actor));
					}
					if (method === 'DELETE') {
						if (!h) {
							throw httpError(404, `no hand-off ${id}`);
						}
						proj.handoffs.delete(id);
						deleteRecordFile(proj, 'handoffs', id);
						logEvent(proj, { type: 'handoff', action: 'delete', actor, id });
						return send(res, 200, { deleted: id });
					}
				}
				if (id && c === 'answer' && method === 'POST') {
					userOnly(actor);
					return send(res, 200, answerHandoff(proj, id, await readBody(req)));
				}
				if (id && c === 'ack' && method === 'POST') {
					return send(res, 200, ackHandoff(proj, id, await readBody(req)));
				}
			}
			if (b === 'message' && method === 'POST') {
				userOnly(actor);
				const body = await readBody(req);
				// Images pasted into the box come as media: uploaded first (POST media), so only this project's files.
				const media = Array.isArray(body.media) ? body.media.filter((m) => m && typeof m.url === 'string' && m.url.startsWith(`/media/${slug}/`)) : [];
				if (!body.text && !media.length) {
					throw httpError(400, 'text or media required');
				}
				const rec = upsertHandoff(proj, { kind: 'message', title: 'Message from the user', question: String(body.text || ''), lane: body.lane, visible: true, ...(media.length ? { media } : {}) }, 'user');
				return send(res, 201, rec);
			}
			// The page's "Tell waiting sessions": wake every pb wait now, with the whole inbox.
			if (b === 'notify' && method === 'POST') {
				userOnly(actor);
				return send(res, 200, { woken: wakeWaiters(proj), inbox: inboxOf(proj).length });
			}
			if (b === 'docs') {
				return docsRoute(req, res, url, method, actor, who, proj, id, c);
			}
			if (b === 'watchers' && method === 'GET') {
				return send(res, 200, { watchers: watchers[slug] || {}, neededBy: neededByMap(slug) });
			}
			if (b === 'inbox' && method === 'GET') {
				return send(res, 200, inboxOf(proj));
			}
			if (b === 'wait' && method === 'GET') {
				const inbox = inboxOf(proj);
				if (inbox.length && url.searchParams.get('fresh') !== '1') {
					return send(res, 200, { woke: false, inbox });
				}
				const timeout = clampInt(url.searchParams.get('timeout'), 1, 3600, 600) * 1000;
				// Headers now and a space every 15 s: proxies drop an idle response.
				// Leading whitespace is still valid JSON.
				res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
				const beat = setInterval(() => res.write(' '), 15000);
				const result = await new Promise((resolve) => {
					const set = waiters.get(slug) || new Set();
					waiters.set(slug, set);
					const w = { resolve, timer: null };
					w.timer = setTimeout(() => {
						set.delete(w);
						broadcast(slug, { type: 'waiters', count: set.size });
						resolve({ woke: false, timeout: true, inbox: inboxOf(proj) });
					}, timeout);
					set.add(w);
					broadcast(slug, { type: 'waiters', count: set.size });
					// The response's close, not the request's: since Node 16 a request emits 'close' once its body is
					// read, which for a GET is at once.
					res.on('close', () => {
						clearTimeout(w.timer);
						if (set.delete(w)) {
							broadcast(slug, { type: 'waiters', count: set.size });
						}
						resolve(null);
					});
				});
				clearInterval(beat);
				if (result && !res.writableEnded) {
					res.end(JSON.stringify(result, null, '\t'));
				}
				return;
			}
			if (b === 'events' && method === 'GET') {
				res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
				res.write(`data: ${JSON.stringify({ type: 'hello', seq: proj.seq, waiters: waiterCount(slug) })}\n\n`);
				const set = sseClients.get(slug) || new Set();
				sseClients.set(slug, set);
				set.add(res);
				// Under common proxy idle timeouts. A data line, not a comment: the page cannot see
				// comments, and it needs these to notice a connection that died without an error.
				const ping = setInterval(() => res.write('data: {"type":"ping"}\n\n'), 15000);
				res.on('close', () => {
					clearInterval(ping);
					set.delete(res);
				});
				return;
			}
			if (b === 'media' && method === 'POST') {
				const name = path.basename(url.searchParams.get('name') || 'upload.bin').replace(/[^A-Za-z0-9._-]/g, '_');
				const buf = await readBody(req, { raw: true });
				const file = `${Date.now()}-${name}`;
				const dir = path.join(projectDir(slug), 'media');
				fs.mkdirSync(dir, { recursive: true });
				fs.writeFileSync(path.join(dir, file), buf);
				return send(res, 201, { url: `/media/${slug}/${file}`, bytes: buf.length });
			}
		}
		throw httpError(404, `no route ${method} ${url.pathname}`);
	}

	if (parts[0] === 'media' && parts.length === 3 && method === 'GET') {
		const [, slug, file] = parts;
		if (!SLUG_RE.test(slug) || file.includes('/') || file.startsWith('.')) {
			throw httpError(400, 'bad media path');
		}
		return serveFile(res, path.join(projectDir(slug), 'media', file));
	}
	if ((parts[0] === 'enrol' || parts[0] === 'enroll') && method === 'GET') {
		return send(res, 200, enrolText({ base: baseUrl(req), root: CLIENT_ROOT, projects: [...projects.values()].map((p) => p.meta), rules: rulesMarkdown(), cliVersion: info && info.version }), { 'Content-Type': 'text/markdown; charset=utf-8' });
	}
	if (parts[0] === 'pb' && parts.length === 1 && method === 'GET') {
		const c = cliFor(req);
		if (!c) {
			throw httpError(404, 'bin/pb is missing on the server');
		}
		res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-SHA256': c.sha256 });
		res.end(c.buf);
		return;
	}
	if (parts[0] === 's' && parts.length === 2 && method === 'GET') {
		return servePage(req, res, path.join(PUBLIC, 'doc.html'));
	}
	if (parts[0] === 's' && parts.length === 3 && parts[2] === 'raw' && method === 'GET') {
		return sendRaw(res, docs.shared(parts[1], projects).doc);
	}
	if (parts[0] === 'd' && parts.length === 3 && method === 'GET') {
		return servePage(req, res, path.join(PUBLIC, 'doc.html'));
	}
	if (parts[0] === 'install' && parts.length === 1 && method === 'GET') {
		return send(res, 200, installScript({ base: baseUrl(req) }), { 'Content-Type': 'text/plain; charset=utf-8' });
	}
	if (parts[0] === 'login' && method === 'GET' && (parts.length === 1 || (parts.length === 2 && parts[1] === 'device'))) {
		return servePage(req, res, path.join(PUBLIC, 'login.html'));
	}
	if (parts[0] === 'upgrade' && method === 'GET') {
		return send(res, 200, upgradeText({ base: baseUrl(req), cliVersion: info && info.version }), { 'Content-Type': 'text/markdown; charset=utf-8' });
	}
	if (parts[0] === 'install-rhel' && method === 'GET') {
		return send(res, 200, fs.readFileSync(path.join(ROOT, 'docs', 'install-rhel.md'), 'utf8'), { 'Content-Type': 'text/markdown; charset=utf-8' });
	}
	if (parts[0] === 'deps' && method === 'GET') {
		return send(res, 200, depsText({ base: baseUrl(req), projects: [...projects.values()].map((p) => p.meta), cliVersion: info && info.version }), { 'Content-Type': 'text/markdown; charset=utf-8' });
	}
	if (parts[0] === 'onboard' && method === 'GET') {
		const slug = parts[1] || null;
		const proj = slug ? projects.get(slug) || null : null;
		return send(res, 200, onboardingText({ base: baseUrl(req), slug, project: proj ? proj.meta : null, root: CLIENT_ROOT, projects: [...projects.values()].map((p) => p.meta), rules: rulesMarkdown(), cliVersion: info && info.version }), { 'Content-Type': 'text/markdown; charset=utf-8' });
	}
	if (method === 'GET') {
		const rel = parts.length === 0 || parts[0] === 'p' ? 'index.html' : parts.join('/');
		const file = path.join(PUBLIC, rel);
		if (!file.startsWith(PUBLIC)) {
			throw httpError(400, 'bad path');
		}
		if (file.endsWith('.html') && fs.existsSync(file)) {
			return servePage(req, res, file);
		}
		return serveFile(res, file);
	}
	throw httpError(404, 'not found');
}

loadAll();

// The board's own project: format requests (and anything else about this server) land here as tasks.
const SYSTEM_SLUG = 'project-boards';
function systemProject() {
	let proj = projects.get(SYSTEM_SLUG);
	if (!proj) {
		const meta = normalizeProject({ slug: SYSTEM_SLUG, name: 'Project Boards (this server)', path: CLIENT_ROOT, description: 'Requests for this server: import formats, features', maxSubagents: 0 });
		proj = { meta, tasks: new Map(), handoffs: new Map(), docs: new Map(), seq: 0 };
		projects.set(SYSTEM_SLUG, proj);
		saveProject(proj);
	}
	return proj;
}
systemProject();

const server = http.createServer((req, res) => {
	route(req, res).catch((e) => {
		if (!res.headersSent) {
			send(res, e.status || 500, { error: e.message });
		} else {
			res.end();
		}
		if (!e.status) {
			console.error(e);
		}
	});
});

server.on('error', (e) => {
	if (e.code === 'EADDRINUSE') {
		console.error(`port ${PORT} is in use (another Project Boards server?); exiting`);
		process.exit(3);
	}
	throw e;
});

server.listen(PORT, HOST, () => {
	console.log(`${now()} Project Boards ${VERSION} on http://${HOST}:${PORT} (data ${DATA}, ${projects.size} projects)`);
});
