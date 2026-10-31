'use strict';

// Logins. One user (the owner of the boards) with a password set by bin/pb-admin; browser sessions (a cookie) for the
// page; app tokens for pb and anything else, got through a device flow (the app opens a tab, the user signs in and
// approves it, the app picks the token up) or made on the page. Only hashes of secrets are stored.
//
// Two files under data/:
//   auth-admin.json  {password: {algo, N, r, p, salt, hash, set}, mode}  written by bin/pb-admin and the settings page
//   auth.json        {sessions: {id: {...}}, tokens: {id: {...}}}           written only by the server
//
// Modes: "off" (no logins at all; the board is open, as before 1.2.0), "optional" (logins work, nothing is refused),
// "required" (everything but the public pages needs a session or a token). PB_AUTH in the environment overrides the file.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MODES = ['off', 'optional', 'required'];
const DEFAULT_MODE = 'optional';
const SESSION_COOKIE = 'pb_session';
const SESSION_MS = 30 * 86400 * 1000; // sliding: each use pushes it out again
const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_INTERVAL_S = 3;
const DEVICE_MAX_PENDING = 50;
const USED_SAVE_MS = 5 * 60 * 1000; // lastUsed alone is written at most this often
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels (no words), no lookalikes
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };

function randomId(bytes = 8) {
	return crypto.randomBytes(bytes).toString('hex');
}

function secret() {
	return crypto.randomBytes(32).toString('base64url');
}

function sha256(s) {
	return crypto.createHash('sha256').update(s).digest('hex');
}

function sameHash(a, b) {
	const x = Buffer.from(String(a), 'hex');
	const y = Buffer.from(String(b), 'hex');
	return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function scrypt(password, salt, { N, r, p, keylen }) {
	return new Promise((resolve, reject) => {
		crypto.scrypt(String(password), Buffer.from(salt, 'hex'), keylen, { N, r, p, maxmem: 128 * N * r * 2 }, (e, key) => (e ? reject(e) : resolve(key)));
	});
}

async function hashPassword(password) {
	const salt = crypto.randomBytes(16).toString('hex');
	const key = await scrypt(password, salt, SCRYPT);
	return { algo: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, salt, hash: key.toString('hex'), set: new Date().toISOString() };
}

async function verifyPassword(rec, password) {
	if (!rec || rec.algo !== 'scrypt') {
		return false;
	}
	const key = await scrypt(password, rec.salt, { N: rec.N, r: rec.r, p: rec.p, keylen: rec.hash.length / 2 });
	return crypto.timingSafeEqual(key, Buffer.from(rec.hash, 'hex'));
}

function readJsonOr(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return fallback;
	}
}

function parseCookies(header) {
	const out = {};
	for (const part of String(header || '').split(';')) {
		const i = part.indexOf('=');
		if (i > 0) {
			out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
		}
	}
	return out;
}

// The address a request really came from. Behind a local proxy it reaches the app from 127.0.0.1 with a forwarded-address
// header; those headers are only believed from loopback, so another client cannot fake them.
function clientIp(req) {
	const sock = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
	if (sock === '127.0.0.1' || sock === '::1') {
		const fwd = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
		if (fwd) {
			return fwd;
		}
	}
	return sock;
}

// Sliding-window counters: allow(key, max, windowMs) is false once `key` has been counted `max` times in the window.
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

function createAuth({ dataDir, writeJson, envMode }) {
	const adminFile = path.join(dataDir, 'auth-admin.json');
	const stateFile = path.join(dataDir, 'auth.json');
	let admin = { mtime: -1, data: {} };
	const state = readJsonOr(stateFile, {});
	state.sessions = state.sessions || {};
	state.tokens = state.tokens || {};
	let usedSaved = Date.now();
	let usedDirty = false;
	const flows = new Map(); // device code hash -> flow
	const byUserCode = new Map(); // user code -> device code hash
	const limits = limiter();

	// bin/pb-admin may change the file at any time (from another machine over the share), so re-read it when it moves.
	function adminData() {
		let mtime = 0;
		try {
			mtime = fs.statSync(adminFile).mtimeMs;
		} catch {
			mtime = 0;
		}
		if (mtime !== admin.mtime) {
			admin = { mtime, data: mtime ? readJsonOr(adminFile, {}) : {} };
		}
		return admin.data;
	}

	function mode() {
		if (MODES.includes(envMode)) {
			return envMode;
		}
		const m = adminData().mode;
		return MODES.includes(m) ? m : DEFAULT_MODE;
	}

	function passwordSet() {
		return !!(adminData().password && adminData().password.hash);
	}

	function save() {
		writeJson(stateFile, state);
		usedSaved = Date.now();
		usedDirty = false;
	}

	function touch(rec, ip) {
		rec.lastUsed = new Date().toISOString();
		if (ip) {
			rec.lastIp = ip;
		}
		usedDirty = true;
		if (Date.now() - usedSaved > USED_SAVE_MS) {
			save();
		}
	}

	// A session made before the password last changed no longer counts: changing the password signs every browser out.
	function sessionValid(s) {
		const set = adminData().password && adminData().password.set;
		return Date.parse(s.lastUsed || s.created) > Date.now() - SESSION_MS && (!set || s.created >= set);
	}

	// Who is calling: {kind: "session"|"token", id, name} or null. Never throws.
	function authenticate(req) {
		if (mode() === 'off') {
			return null;
		}
		const ip = clientIp(req);
		const bearer = /^Bearer\s+pbt_([0-9a-f]{16})_([A-Za-z0-9_-]{20,})$/.exec(String(req.headers.authorization || ''));
		if (bearer) {
			const t = state.tokens[bearer[1]];
			if (t && sameHash(t.hash, sha256(bearer[2]))) {
				touch(t, ip);
				return { kind: 'token', id: bearer[1], name: t.name };
			}
			return null;
		}
		const m = /^([0-9a-f]{16})\.([A-Za-z0-9_-]{20,})$/.exec(parseCookies(req.headers.cookie)[SESSION_COOKIE] || '');
		if (m) {
			const s = state.sessions[m[1]];
			if (s && sameHash(s.hash, sha256(m[2])) && sessionValid(s)) {
				touch(s, ip);
				return { kind: 'session', id: m[1], name: 'browser' };
			}
		}
		return null;
	}

	function cookieHeader(value, req, maxAgeS) {
		const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
		return `${SESSION_COOKIE}=${value}; Path=${req.pbBase || '/'}; HttpOnly; SameSite=Lax; Max-Age=${maxAgeS}${https ? '; Secure' : ''}`;
	}

	function authError(status, message, extra = {}) {
		const e = new Error(message);
		e.status = status;
		Object.assign(e, extra);
		return e;
	}

	function requireOn() {
		if (mode() === 'off') {
			throw authError(409, 'logins are turned off on this server (mode "off")');
		}
	}

	// Returns the Set-Cookie value for a new session, or throws 401/429.
	async function login(req, password) {
		requireOn();
		const ip = clientIp(req);
		if (!passwordSet()) {
			throw authError(409, 'no password is set yet: run bin/pb-admin set-password where the server\'s data folder is reachable');
		}
		if (!limits.allow(`login:${ip}`, 5, 15 * 60 * 1000) || !limits.allow('login:*', 30, 15 * 60 * 1000)) {
			throw authError(429, 'too many wrong passwords; wait 15 minutes');
		}
		if (!(await verifyPassword(adminData().password, password))) {
			limits.hit(`login:${ip}`);
			limits.hit('login:*');
			throw authError(401, 'wrong password');
		}
		const id = randomId();
		const sec = secret();
		const now = new Date().toISOString();
		state.sessions[id] = { hash: sha256(sec), created: now, lastUsed: now, lastIp: ip, agent: String(req.headers['user-agent'] || '').slice(0, 200) };
		save();
		return cookieHeader(`${id}.${sec}`, req, SESSION_MS / 1000);
	}

	function logout(req, who) {
		if (who && who.kind === 'session') {
			delete state.sessions[who.id];
			save();
		}
		return cookieHeader('', req, 0);
	}

	function newToken({ name, client, machine, project, via, ip }) {
		const id = randomId();
		const sec = secret();
		const now = new Date().toISOString();
		state.tokens[id] = { hash: sha256(sec), name: String(name || client || 'app').slice(0, 100), client: String(client || '').slice(0, 100),
			machine: String(machine || '').slice(0, 100), project: String(project || '').slice(0, 100), via, created: now, lastUsed: null, lastIp: ip || '' };
		save();
		return { token: `pbt_${id}_${sec}`, id, name: state.tokens[id].name };
	}

	function listCredentials(who) {
		const strip = ({ hash: _h, ...rest }) => rest;
		return {
			tokens: Object.entries(state.tokens).map(([id, t]) => ({ id, ...strip(t), current: !!who && who.id === id })).sort((a, b) => (a.created < b.created ? 1 : -1)),
			sessions: Object.entries(state.sessions).filter(([, s]) => sessionValid(s)).map(([id, s]) => ({ id, ...strip(s), current: !!who && who.id === id }))
				.sort((a, b) => ((a.lastUsed || '') < (b.lastUsed || '') ? 1 : -1)),
		};
	}

	function revoke(id) {
		if (state.tokens[id]) {
			delete state.tokens[id];
		} else if (state.sessions[id]) {
			delete state.sessions[id];
		} else {
			throw authError(404, `no token or session ${id}`);
		}
		save();
		return { revoked: id };
	}

	function setMode(m, writeAdmin) {
		if (!MODES.includes(m)) {
			throw authError(400, `mode must be one of ${MODES.join(', ')}`);
		}
		if (MODES.includes(envMode)) {
			throw authError(409, `the mode is pinned to "${envMode}" by PB_AUTH in the server's environment`);
		}
		if (m === 'required' && !passwordSet()) {
			throw authError(409, 'set a password first (bin/pb-admin set-password)');
		}
		writeAdmin({ ...readJsonOr(adminFile, {}), mode: m });
		admin.mtime = -1;
		return mode();
	}

	// ---- Device flow (RFC 8628 in spirit): the app starts it, the user approves it in a browser, the app polls.

	function sweep() {
		const t = Date.now();
		for (const [k, f] of flows) {
			if (f.expires < t) {
				flows.delete(k);
				byUserCode.delete(f.userCode);
			}
		}
	}

	function userCode() {
		let code;
		do {
			const b = crypto.randomBytes(8);
			code = [...b].map((x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]).join('');
			code = `${code.slice(0, 4)}-${code.slice(4)}`;
		} while (byUserCode.has(code));
		return code;
	}

	function startDevice(req, { client, machine, project }, base) {
		requireOn();
		sweep();
		const ip = clientIp(req);
		if (flows.size >= DEVICE_MAX_PENDING || !limits.allow(`device:${ip}`, 10, 10 * 60 * 1000)) {
			throw authError(429, 'too many sign-in requests; wait a few minutes');
		}
		limits.hit(`device:${ip}`);
		const deviceCode = secret();
		const code = userCode();
		const flow = { userCode: code, client: String(client || 'an app').slice(0, 100), machine: String(machine || '').slice(0, 100),
			project: String(project || '').slice(0, 100), ip, created: new Date().toISOString(), expires: Date.now() + DEVICE_TTL_MS, status: 'pending', lastPoll: 0 };
		flows.set(sha256(deviceCode), flow);
		byUserCode.set(code, sha256(deviceCode));
		return {
			device_code: deviceCode, user_code: code, verification_uri: `${base}/login/device`,
			verification_uri_complete: `${base}/login/device?code=${code}`, expires_in: DEVICE_TTL_MS / 1000, interval: DEVICE_INTERVAL_S,
		};
	}

	function flowByUserCode(code) {
		sweep();
		const key = byUserCode.get(String(code || '').toUpperCase().replace(/[^A-Z]/g, '').replace(/^(.{4})(.{4})$/, '$1-$2'));
		const f = key && flows.get(key);
		if (!f) {
			throw authError(404, 'no such code, or it has expired (codes last 10 minutes): start the sign-in again from the app');
		}
		return f;
	}

	function describeDevice(code) {
		const f = flowByUserCode(code);
		return { user_code: f.userCode, client: f.client, machine: f.machine, project: f.project, ip: f.ip, created: f.created, status: f.status };
	}

	function decideDevice(code, approve) {
		const f = flowByUserCode(code);
		if (f.status !== 'pending') {
			throw authError(409, `this sign-in was already ${f.status}`);
		}
		if (approve) {
			f.status = 'approved';
			f.issued = newToken({ name: [f.client, f.machine && `on ${f.machine}`, f.project && `(${f.project})`].filter(Boolean).join(' '), client: f.client,
				machine: f.machine, project: f.project, via: 'device', ip: f.ip });
		} else {
			f.status = 'denied';
		}
		return { status: f.status };
	}

	// What the polling app gets: a token once approved (handed over exactly once), else an RFC 8628 error code.
	function pollDevice(deviceCode) {
		sweep();
		const key = sha256(String(deviceCode || ''));
		const f = flows.get(key);
		if (!f) {
			throw authError(400, 'expired_token', { code: 'expired_token' });
		}
		const t = Date.now();
		if (t - f.lastPoll < (DEVICE_INTERVAL_S - 1) * 1000) {
			f.lastPoll = t;
			throw authError(400, 'slow_down', { code: 'slow_down' });
		}
		f.lastPoll = t;
		if (f.status === 'denied') {
			flows.delete(key);
			byUserCode.delete(f.userCode);
			throw authError(400, 'access_denied', { code: 'access_denied' });
		}
		if (f.status !== 'approved') {
			throw authError(400, 'authorization_pending', { code: 'authorization_pending' });
		}
		flows.delete(key);
		byUserCode.delete(f.userCode);
		return f.issued;
	}

	// Keep lastUsed from being lost entirely when nothing else writes the file for a while.
	setInterval(() => usedDirty && save(), USED_SAVE_MS).unref();

	return {
		mode, passwordSet, authenticate, login, logout, newToken, listCredentials, revoke, setMode,
		startDevice, describeDevice, decideDevice, pollDevice, clientIp, adminFile, requireOn,
	};
}

module.exports = { createAuth, hashPassword, verifyPassword, MODES, SESSION_COOKIE };
