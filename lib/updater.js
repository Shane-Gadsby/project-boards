'use strict';

// Updating from the page. The check asks GitHub for the latest published release. Installing depends on how the server is
// run, set by PB_UPDATE_MODE or "update" in data/publish.json:
//   systemd  the service cannot write its code, so it asks: it writes the version to a request file, and a root unit
//            installs that release with the normal installer (packaging/rhel/project-boards-update).
//   inplace  the code folder is writable and a process manager restarts the server: it replaces its own files and exits.
//   (unset)  no installing from the page; it shows the command instead.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawnSync } = require('child_process');

const RELEASES_URL = process.env.PB_RELEASES_URL || 'https://api.github.com/repos/Shane-Gadsby/project-boards/releases/latest';
const CHECK_TTL_MS = 10 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const SYSTEMD_STATUS = process.env.PB_UPDATE_STATUS || '/var/lib/project-boards-updater/status.json';

// curl, not fetch: Node's fetch ignores http_proxy, https_proxy and no_proxy, and curl is on any server that can install.
function curl(url, headers, timeoutS) {
	const args = ['-fsSL', '--max-time', String(timeoutS), ...headers.flatMap((h) => ['-H', h]), url];
	return new Promise((resolve, reject) => {
		execFile('curl', args, { encoding: 'buffer', maxBuffer: 512 * 1024 * 1024 }, (e, stdout, stderr) => {
			if (e) {
				const why = e.code === 'ENOENT' ? 'curl is not installed' : String(stderr).trim().replace(/^curl: \(\d+\) /, '') || e.message;
				reject(new Error(why));
			} else {
				resolve(stdout);
			}
		});
	});
}

function newerThan(a, b) {
	const x = String(a).split('.').map(Number);
	const y = String(b).split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		if ((x[i] || 0) !== (y[i] || 0)) {
			return (x[i] || 0) > (y[i] || 0);
		}
	}
	return false;
}

function createUpdater({ root, dataDir, version, mode, httpError }) {
	let cached = null;
	let running = false;
	const requestFile = path.join(dataDir, 'update', 'request');
	const statusFile = mode() === 'systemd' ? SYSTEMD_STATUS : path.join(dataDir, 'update-status.json');

	function readStatus() {
		try {
			return JSON.parse(fs.readFileSync(statusFile, 'utf8'));
		} catch {
			return null;
		}
	}

	function writeStatus(status) {
		fs.writeFileSync(statusFile, `${JSON.stringify({ ...status, at: new Date().toISOString() })}\n`);
	}

	async function latest(force) {
		if (!force && cached && Date.now() - cached.at < CHECK_TTL_MS) {
			return cached.release;
		}
		let r;
		try {
			r = JSON.parse(await curl(RELEASES_URL, ['Accept: application/vnd.github+json', `User-Agent: project-boards/${version}`], 20));
		} catch (e) {
			throw httpError(502, `could not reach GitHub from the server (${e.message}). If it needs a proxy, set https_proxy in /etc/environment or the server's environment`);
		}
		const release = { version: String(r.tag_name || '').replace(/^v/, ''), notes: String(r.body || ''), url: r.html_url || '', assets: r.assets || [] };
		if (!VERSION_RE.test(release.version)) {
			throw httpError(502, `the latest release has an unexpected tag: ${r.tag_name}`);
		}
		cached = { at: Date.now(), release };
		return release;
	}

	async function check(force) {
		const r = await latest(force);
		return {
			current: version, latest: r.version, available: newerThan(r.version, version), notes: r.notes, url: r.url,
			mode: mode() || null, status: readStatus(),
		};
	}

	function download(url) {
		return curl(url, [], 120);
	}

	async function installInPlace(release) {
		const name = `project-boards-${release.version}`;
		const asset = (n) => release.assets.find((a) => a.name === n);
		if (!asset(`${name}.tar.gz`) || !asset(`${name}.tar.gz.sha256`)) {
			throw new Error(`release ${release.version} has no server bundle`);
		}
		const tar = await download(asset(`${name}.tar.gz`).browser_download_url);
		const want = (await download(asset(`${name}.tar.gz.sha256`).browser_download_url)).toString().trim().split(/\s+/)[0];
		if (crypto.createHash('sha256').update(tar).digest('hex') !== want) {
			throw new Error('the download does not match its checksum; nothing was changed');
		}
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pb-update-'));
		try {
			fs.writeFileSync(path.join(work, 'bundle.tar.gz'), tar);
			const t = spawnSync('tar', ['-xzf', 'bundle.tar.gz'], { cwd: work });
			if (t.status !== 0) {
				throw new Error(`could not unpack the bundle: ${t.stderr}`);
			}
			const from = path.join(work, name);
			if (fs.readFileSync(path.join(from, 'VERSION'), 'utf8').trim() !== release.version) {
				throw new Error('the bundle is not the version it claims; nothing was changed');
			}
			for (const item of ['lib', 'public', 'bin', 'docs']) {
				fs.cpSync(path.join(from, item), path.join(root, item), { recursive: true });
			}
			// Last: until this lands, a restart still runs the old server, which reads the same files.
			fs.copyFileSync(path.join(from, 'server.js'), path.join(root, 'server.js'));
		} finally {
			fs.rmSync(work, { recursive: true, force: true });
		}
	}

	// Only ever the latest published release, and only forwards.
	async function start(wanted) {
		if (running) {
			throw httpError(409, 'an update is already running');
		}
		const m = mode();
		if (m !== 'systemd' && m !== 'inplace') {
			throw httpError(409, 'updating from the page is not set up on this server');
		}
		const r = await latest(true);
		if (wanted !== r.version || !newerThan(r.version, version)) {
			throw httpError(409, `${wanted} is not a newer release (latest is ${r.version}, this is ${version})`);
		}
		running = true;
		if (m === 'systemd') {
			fs.mkdirSync(path.dirname(requestFile), { recursive: true });
			const tmp = `${requestFile}.tmp`;
			fs.writeFileSync(tmp, `${r.version}\n`);
			fs.renameSync(tmp, requestFile);
			// The unit restarts this process when it finishes; if it fails, let the page ask again.
			setTimeout(() => {
				running = false;
			}, 60000).unref();
			return { started: r.version };
		}
		writeStatus({ state: 'running', version: r.version });
		installInPlace(r).then(() => {
			writeStatus({ state: 'done', version: r.version });
			console.log(`updated to ${r.version}; exiting for the process manager to restart`);
			setTimeout(() => process.exit(0), 300);
		}, (e) => {
			running = false;
			console.error(`update failed: ${e.message}`);
			writeStatus({ state: 'failed', version: r.version, error: e.message });
		});
		return { started: r.version };
	}

	return { check, start };
}

module.exports = { createUpdater, newerThan };
