'use strict';

// Reports: what a build out in the world sends back (crash reports, diagnostics, tester notes). They arrive on one
// endpoint, POST /api/ingest, with an ingest key: a write-only credential that can do nothing else. A key names one
// project, can only add reports to it, and can never read the board - no tasks, no hand-offs, no docs, not even the
// list of reports it has written. Keys are rate limited per key and per address, and can be rotated or revoked.
//
// data/projects/<slug>/reports/<id>.json  one report each (newest id sorts last)
// data/ingest-keys.json                   {id: {hash, slug, name, created, createdBy, disabled, lastUsed, lastIp, count}}
//
// Only the hash of a key is kept, so a lost key is rotated, never recovered.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATUSES = ['new', 'kept', 'done'];
const MAX_BYTES = Number(process.env.PB_INGEST_MAX || 256 * 1024); // one report
const MAX_PER_PROJECT = Number(process.env.PB_REPORTS_MAX || 2000); // the oldest go when a project is over this
const FIELDS = ['title', 'kind', 'summary', 'app', 'version', 'platform', 'contact', 'text'];
const LIMITS = {
	keyMinute: Number(process.env.PB_INGEST_PER_KEY_MINUTE || 20),
	keyHour: Number(process.env.PB_INGEST_PER_KEY_HOUR || 200),
	ipMinute: Number(process.env.PB_INGEST_PER_IP_MINUTE || 30),
	ipHour: Number(process.env.PB_INGEST_PER_IP_HOUR || 300),
};

function sha256(s) {
	return crypto.createHash('sha256').update(s).digest('hex');
}

function sameHash(a, b) {
	const x = Buffer.from(String(a), 'hex');
	const y = Buffer.from(String(b), 'hex');
	return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function str(v, max) {
	return String(v === undefined || v === null ? '' : v).slice(0, max);
}

// Sliding-window counters, as in lib/auth.js: allow(key, max, windowMs) is false once it has been counted max times.
function limiter() {
	const hits = new Map();
	return {
		allow(key, max, windowMs) {
			const t = Date.now();
			const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
			hits.set(key, list);
			return list.length < max;
		},
		hit(key) {
			const list = hits.get(key) || [];
			list.push(Date.now());
			hits.set(key, list);
		},
	};
}

function createReports({ dataDir, projectDir, writeJson, readJson, logEvent, httpError, now }) {
	const keysFile = path.join(dataDir, 'ingest-keys.json');
	let keys = {};
	try {
		keys = readJson(keysFile);
	} catch {
		keys = {};
	}
	const limits = limiter();
	let usedDirty = false;
	let usedSaved = Date.now();

	const reportFile = (proj, id) => path.join(projectDir(proj.meta.slug), 'reports', `${id}.json`);

	function saveKeys() {
		writeJson(keysFile, keys);
		usedDirty = false;
		usedSaved = Date.now();
	}

	// lastUsed on its own is written at most every 5 minutes: a beta flood should not rewrite the file per report.
	function touch(rec, ip) {
		rec.lastUsed = now();
		rec.lastIp = ip || '';
		rec.count = (rec.count || 0) + 1;
		usedDirty = true;
		if (Date.now() - usedSaved > 5 * 60 * 1000) {
			saveKeys();
		}
	}

	function flush() {
		if (usedDirty) {
			saveKeys();
		}
	}

	function publicKey(id) {
		const { hash: _h, ...rest } = keys[id];
		return { id, ...rest };
	}

	function listKeys(slug) {
		return Object.keys(keys).filter((id) => keys[id].slug === slug).map(publicKey)
			.sort((a, b) => (a.created < b.created ? 1 : -1));
	}

	function makeKey(slug, name, actor) {
		const id = crypto.randomBytes(8).toString('hex');
		const secret = crypto.randomBytes(32).toString('base64url');
		keys[id] = { hash: sha256(secret), slug, name: str(name, 100) || 'beta build', created: now(), createdBy: actor, disabled: false,
			lastUsed: null, lastIp: '', count: 0 };
		saveKeys();
		return { ...publicKey(id), key: `pbk_${id}_${secret}` };
	}

	function getKey(slug, id) {
		const rec = keys[id];
		if (!rec || rec.slug !== slug) {
			throw httpError(404, `no ingest key ${id} on ${slug}`);
		}
		return rec;
	}

	// Rotating keeps the key's name and history and only changes the secret: the old key stops working at once.
	function rotateKey(slug, id) {
		const rec = getKey(slug, id);
		const secret = crypto.randomBytes(32).toString('base64url');
		rec.hash = sha256(secret);
		rec.rotated = now();
		saveKeys();
		return { ...publicKey(id), key: `pbk_${id}_${secret}` };
	}

	function patchKey(slug, id, body) {
		const rec = getKey(slug, id);
		if (body.name !== undefined) {
			rec.name = str(body.name, 100) || rec.name;
		}
		if (body.disabled !== undefined) {
			rec.disabled = !!body.disabled;
		}
		saveKeys();
		return publicKey(id);
	}

	function revokeKey(slug, id) {
		getKey(slug, id);
		delete keys[id];
		saveKeys();
		return { revoked: id };
	}

	function removeProject(slug) {
		let changed = false;
		for (const [id, k] of Object.entries(keys)) {
			if (k.slug === slug) {
				delete keys[id];
				changed = true;
			}
		}
		if (changed) {
			saveKeys();
		}
	}

	// The key behind an Authorization header, or null. Never says which part was wrong.
	function keyFrom(header) {
		const m = /^Bearer\s+pbk_([0-9a-f]{16})_([A-Za-z0-9_-]{20,})$/.exec(String(header || ''));
		if (!m) {
			return null;
		}
		const rec = keys[m[1]];
		if (!rec || rec.disabled || !sameHash(rec.hash, sha256(m[2]))) {
			return null;
		}
		return { id: m[1], ...rec };
	}

	function reportId() {
		return `${now().replace(/[-:T.]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
	}

	// Over MAX_PER_PROJECT, the oldest reports go; a done one goes before a new one of the same age.
	function trim(proj) {
		const over = proj.reports.size - MAX_PER_PROJECT;
		if (over <= 0) {
			return;
		}
		const oldest = [...proj.reports.values()]
			.sort((a, b) => (a.status === b.status ? String(a.id).localeCompare(String(b.id)) : a.status === 'done' ? -1 : b.status === 'done' ? 1 : 0))
			.slice(0, over);
		for (const r of oldest) {
			proj.reports.delete(r.id);
			fs.rmSync(reportFile(proj, r.id), { force: true });
		}
	}

	// A report arriving on a key. Throws 413/429 with nothing about the board in the message.
	function ingest(proj, key, body, ip, bytes) {
		if (bytes > MAX_BYTES) {
			throw httpError(413, `a report may be up to ${Math.round(MAX_BYTES / 1024)} KB`);
		}
		if (!limits.allow(`k:${key.id}:m`, LIMITS.keyMinute, 60000) || !limits.allow(`k:${key.id}:h`, LIMITS.keyHour, 3600000)
			|| !limits.allow(`i:${ip}:m`, LIMITS.ipMinute, 60000) || !limits.allow(`i:${ip}:h`, LIMITS.ipHour, 3600000)) {
			throw httpError(429, 'too many reports; try again later');
		}
		for (const k of [`k:${key.id}:m`, `k:${key.id}:h`, `i:${ip}:m`, `i:${ip}:h`]) {
			limits.hit(k);
		}
		const rec = {
			id: reportId(),
			received: now(),
			status: 'new',
			key: { id: key.id, name: key.name },
			from: ip,
			title: str(body.title, 200) || 'Report',
			kind: str(body.kind, 40) || 'report',
			summary: str(body.summary, 500),
			app: str(body.app, 100),
			version: str(body.version, 60),
			platform: str(body.platform, 120),
			contact: str(body.contact, 200),
			text: str(body.text, 20000),
			data: body.data === undefined ? null : body.data,
			size: bytes,
		};
		proj.reports.set(rec.id, rec);
		writeJson(reportFile(proj, rec.id), rec);
		trim(proj);
		touch(keys[key.id], ip);
		logEvent(proj, { type: 'report', action: 'create', actor: 'ingest', id: rec.id, record: meta(rec) });
		return { ok: true, id: rec.id };
	}

	// What the list and the live events carry: everything but the payload, which can be large.
	function meta(rec) {
		const { data: _d, text: _t, ...rest } = rec;
		return { ...rest, hasData: rec.data !== null && rec.data !== undefined, hasText: !!rec.text };
	}

	function list(proj, { status, q, limit } = {}) {
		let out = [...proj.reports.values()];
		if (status) {
			out = out.filter((r) => r.status === status);
		}
		if (q) {
			const needle = String(q).toLowerCase();
			out = out.filter((r) => `${r.title} ${r.summary} ${r.app} ${r.version} ${r.platform} ${r.contact} ${r.kind}`.toLowerCase().includes(needle));
		}
		out.sort((a, b) => String(b.id).localeCompare(String(a.id)));
		const n = Number(limit);
		return (Number.isFinite(n) && n > 0 ? out.slice(0, n) : out).map(meta);
	}

	function get(proj, id) {
		const rec = proj.reports.get(String(id));
		if (!rec) {
			throw httpError(404, `no report ${id}`);
		}
		return rec;
	}

	function setStatus(proj, id, status, actor) {
		if (!STATUSES.includes(status)) {
			throw httpError(400, `status must be one of ${STATUSES.join(', ')}`);
		}
		const rec = { ...get(proj, id), status, statusAt: now(), statusBy: actor };
		proj.reports.set(rec.id, rec);
		writeJson(reportFile(proj, rec.id), rec);
		logEvent(proj, { type: 'report', action: 'update', actor, id: rec.id, record: meta(rec) });
		return meta(rec);
	}

	function remove(proj, id, actor) {
		const rec = get(proj, id);
		proj.reports.delete(rec.id);
		fs.rmSync(reportFile(proj, rec.id), { force: true });
		logEvent(proj, { type: 'report', action: 'delete', actor, id: rec.id });
		return { deleted: rec.id };
	}

	function newCount(proj) {
		let n = 0;
		for (const r of proj.reports.values()) {
			if (r.status === 'new') {
				n += 1;
			}
		}
		return n;
	}

	return { listKeys, makeKey, rotateKey, patchKey, revokeKey, removeProject, keyFrom, ingest, list, get, setStatus, remove, meta, newCount, flush, STATUSES, LIMITS, MAX_BYTES };
}

module.exports = { createReports, STATUSES, MAX_BYTES };
