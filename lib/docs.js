'use strict';

// Docs: per-project documents (gists / artifacts) that apps write and the user reads, edits and presents.
// data/projects/<slug>/docs/<id>.json is the current version; <id>.history.jsonl keeps the last HISTORY_MAX versions
// (one JSON line each, content included). Share links live in data/shares.json: {token: {slug, id, created}}.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FORMATS = ['markdown', 'html', 'svg', 'json', 'csv', 'code', 'text'];
const MAX_CONTENT = 5 * 1024 * 1024;
const HISTORY_MAX = 50;
const FIELDS = ['title', 'format', 'language', 'summary', 'tags', 'content', 'source'];

// What the raw endpoint answers with (text formats as plain text so a browser shows them). HTML and SVG can carry script: they are served with a CSP sandbox and no
// allow-same-origin, so they run in an opaque origin and can never act with the viewer's session.
const RAW_TYPES = {
	markdown: 'text/plain; charset=utf-8', html: 'text/html; charset=utf-8', svg: 'image/svg+xml', json: 'application/json; charset=utf-8',
	csv: 'text/plain; charset=utf-8', code: 'text/plain; charset=utf-8', text: 'text/plain; charset=utf-8',
};
const SANDBOX_CSP = 'sandbox allow-scripts allow-popups allow-forms allow-modals';

const EXT_FORMATS = { md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', svg: 'svg', json: 'json', csv: 'csv', txt: 'text', log: 'text' };

function formatFromName(name) {
	const ext = String(name || '').toLowerCase().split('.').pop();
	return EXT_FORMATS[ext] || (ext && ext !== String(name).toLowerCase() ? 'code' : 'text');
}

function createDocs({ dataDir, projectDir, writeJson, readJson, logEvent, httpError, now, slugify, idRe }) {
	const sharesFile = path.join(dataDir, 'shares.json');
	let shares = {};
	try {
		shares = readJson(sharesFile);
	} catch {
		shares = {};
	}

	const docFile = (proj, id) => path.join(projectDir(proj.meta.slug), 'docs', `${id}.json`);
	const historyFile = (proj, id) => path.join(projectDir(proj.meta.slug), 'docs', `${id}.history.jsonl`);

	function meta(rec) {
		const { content: _c, ...rest } = rec;
		return rest;
	}

	function readHistory(proj, id) {
		try {
			return fs.readFileSync(historyFile(proj, id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
		} catch {
			return [];
		}
	}

	function appendHistory(proj, rec, actor, note) {
		const line = { version: rec.version, at: rec.updated, by: actor, note: note || '', title: rec.title, format: rec.format, language: rec.language || '', content: rec.content };
		const file = historyFile(proj, rec.id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, JSON.stringify(line) + '\n');
		const all = readHistory(proj, rec.id);
		if (all.length > HISTORY_MAX) {
			const tmp = `${file}.tmp-${process.pid}`;
			fs.writeFileSync(tmp, all.slice(-HISTORY_MAX).map((l) => JSON.stringify(l)).join('\n') + '\n');
			fs.renameSync(tmp, file);
		}
	}

	function validate(rec) {
		if (!FORMATS.includes(rec.format)) {
			throw httpError(400, `format must be one of ${FORMATS.join(', ')}`);
		}
		if (typeof rec.content !== 'string') {
			throw httpError(400, 'content must be a string (upload binary files as media and link them)');
		}
		if (Buffer.byteLength(rec.content) > MAX_CONTENT) {
			throw httpError(413, `content is over ${MAX_CONTENT / 1024 / 1024} MB`);
		}
		if (!String(rec.title || '').trim()) {
			throw httpError(400, 'a doc needs a title');
		}
		if (rec.tags !== undefined && !(Array.isArray(rec.tags) && rec.tags.every((t) => typeof t === 'string'))) {
			throw httpError(400, 'tags must be an array of strings');
		}
	}

	// Create or update. `create`/`update` say which are allowed (POST creates only, PATCH updates only, PUT either).
	function upsert(proj, body, actor, { create = true, update = true } = {}) {
		let id = body.id ? String(body.id) : null;
		if (id !== null && !idRe.test(id)) {
			throw httpError(400, `bad doc id "${id}" (letters, digits, . _ -)`);
		}
		const existing = id !== null ? proj.docs.get(id) : null;
		const t = now();
		let rec;
		if (existing) {
			if (!update) {
				throw httpError(409, `doc ${id} exists`);
			}
			if (body.ifVersion !== undefined && body.ifVersion !== null && Number(body.ifVersion) !== existing.version) {
				throw httpError(409, `doc ${id} is at version ${existing.version}, not ${body.ifVersion}: someone changed it meanwhile`);
			}
			rec = { ...existing };
			for (const k of FIELDS) {
				if (body[k] !== undefined) {
					rec[k] = body[k];
				}
			}
			validate(rec);
			const changed = FIELDS.some((k) => JSON.stringify(rec[k]) !== JSON.stringify(existing[k]));
			if (!changed) {
				return existing;
			}
			rec.version = existing.version + 1;
		} else {
			if (!create) {
				throw httpError(404, `no doc ${id}`);
			}
			if (id === null) {
				const base = slugify(body.title);
				id = base;
				for (let n = 2; proj.docs.has(id); n++) {
					id = `${base}-${n}`;
				}
			}
			rec = { id, title: '', format: body.format || formatFromName(body.name), language: '', summary: '', tags: [], content: '', created: t, createdBy: actor, version: 1 };
			for (const k of FIELDS) {
				if (body[k] !== undefined) {
					rec[k] = body[k];
				}
			}
			validate(rec);
		}
		rec.updated = t;
		rec.updatedBy = actor;
		rec.size = Buffer.byteLength(rec.content);
		// The user's edits are news for Claude (pb inbox lists them until seen); Claude's own writes count as seen.
		if (actor === 'user') {
			rec.userUpdatedAt = t;
		} else {
			rec.seenAt = t;
		}
		proj.docs.set(rec.id, rec);
		writeJson(docFile(proj, rec.id), rec);
		appendHistory(proj, rec, actor, body.note);
		logEvent(proj, { type: 'doc', action: existing ? 'update' : 'create', actor, id: rec.id, record: meta(rec) });
		return rec;
	}

	function get(proj, id) {
		const rec = proj.docs.get(id);
		if (!rec) {
			throw httpError(404, `no doc ${id}`);
		}
		return rec;
	}

	function atVersion(proj, id, version) {
		const rec = get(proj, id);
		if (version === undefined || version === null || version === '' || Number(version) === rec.version) {
			return rec;
		}
		const h = readHistory(proj, id).find((l) => l.version === Number(version));
		if (!h) {
			throw httpError(404, `doc ${id} has no version ${version} kept (the last ${HISTORY_MAX} are)`);
		}
		return { ...meta(rec), title: h.title, format: h.format, language: h.language, content: h.content, version: h.version, updated: h.at, updatedBy: h.by, size: Buffer.byteLength(h.content), old: true, latest: rec.version };
	}

	function list(proj, { tag, q, unseen } = {}) {
		let all = [...proj.docs.values()];
		if (tag) {
			all = all.filter((d) => (d.tags || []).includes(tag));
		}
		if (unseen) {
			all = all.filter((d) => d.userUpdatedAt && (!d.seenAt || d.userUpdatedAt > d.seenAt));
		}
		if (q) {
			const needle = String(q).toLowerCase();
			all = all.filter((d) => `${d.id} ${d.title} ${d.summary} ${(d.tags || []).join(' ')} ${d.content}`.toLowerCase().includes(needle));
		}
		return all.sort((a, b) => (a.updated < b.updated ? 1 : -1)).map(meta);
	}

	function history(proj, id) {
		get(proj, id);
		return readHistory(proj, id).map(({ content, ...rest }) => ({ ...rest, size: Buffer.byteLength(content) })).reverse();
	}

	function markSeen(proj, id) {
		const rec = { ...get(proj, id), seenAt: now() };
		proj.docs.set(id, rec);
		writeJson(docFile(proj, id), rec);
		return meta(rec);
	}

	function remove(proj, id, actor) {
		const rec = get(proj, id);
		proj.docs.delete(id);
		for (const f of [docFile(proj, id), historyFile(proj, id)]) {
			fs.rmSync(f, { force: true });
		}
		if (rec.share) {
			delete shares[rec.share];
			writeJson(sharesFile, shares);
		}
		logEvent(proj, { type: 'doc', action: 'delete', actor, id });
		return { deleted: id };
	}

	// A share link is a random token anyone can open without signing in; only the signed-in user makes or removes one.
	function share(proj, id, actor) {
		const rec = get(proj, id);
		if (rec.share && shares[rec.share]) {
			return rec.share;
		}
		const token = crypto.randomBytes(18).toString('base64url');
		shares[token] = { slug: proj.meta.slug, id, created: now() };
		writeJson(sharesFile, shares);
		const next = { ...rec, share: token };
		proj.docs.set(id, next);
		writeJson(docFile(proj, id), next);
		logEvent(proj, { type: 'doc', action: 'update', actor, id, record: meta(next) });
		return token;
	}

	function unshare(proj, id, actor) {
		const rec = get(proj, id);
		if (rec.share) {
			delete shares[rec.share];
			writeJson(sharesFile, shares);
		}
		const { share: _s, ...next } = rec;
		proj.docs.set(id, next);
		writeJson(docFile(proj, id), next);
		logEvent(proj, { type: 'doc', action: 'update', actor, id, record: meta(next) });
		return { unshared: id };
	}

	// The share links of a project that is being deleted.
	function removeProject(slug) {
		let changed = false;
		for (const [token, s] of Object.entries(shares)) {
			if (s.slug === slug) {
				delete shares[token];
				changed = true;
			}
		}
		if (changed) {
			writeJson(sharesFile, shares);
		}
	}

	function shared(token, projects) {
		const s = shares[String(token || '')];
		const proj = s && projects.get(s.slug);
		const rec = proj && proj.docs.get(s.id);
		if (!rec || rec.share !== token) {
			throw httpError(404, 'this share link does not exist (any more)');
		}
		return { project: { slug: proj.meta.slug, name: proj.meta.name }, doc: { id: rec.id, title: rec.title, format: rec.format, language: rec.language, summary: rec.summary, content: rec.content, version: rec.version, updated: rec.updated } };
	}

	return { upsert, get, atVersion, list, history, markSeen, remove, removeProject, share, unshare, shared, meta, FORMATS };
}

module.exports = { createDocs, formatFromName, RAW_TYPES, SANDBOX_CSP, FORMATS };
