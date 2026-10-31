'use strict';
// A doc on a page of its own. /d/<project>/<id>: signed in, follows changes live. /s/<token>: a share link, read-only,
// no sign-in (the token is the permission).

const $ = (sel) => document.querySelector(sel);
const [, kind, a, b] = location.pathname.split('/').map(decodeURIComponent);
const shared = kind === 's';

function ago(iso) {
	const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
	return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
}

async function getJson(url) {
	const res = await fetch(url, { headers: { 'X-PB-Actor': 'user' } });
	if (res.status === 401) {
		location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
		throw new Error('signing in');
	}
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = new Error(data.error || `${res.status}`);
		err.status = res.status;
		throw err;
	}
	return data;
}

let shownVersion = null;

async function load() {
	let project;
	let doc;
	let raw;
	if (shared) {
		({ project, doc } = await getJson(`/api/shared/${encodeURIComponent(a)}`));
		raw = `/s/${encodeURIComponent(a)}/raw?v=${doc.version}`;
	} else {
		const p = `/api/projects/${encodeURIComponent(a)}`;
		[project, doc] = await Promise.all([getJson(p), getJson(`${p}/docs/${encodeURIComponent(b)}`)]);
		raw = `${p}/docs/${encodeURIComponent(b)}/raw?version=${doc.version}`;
		const board = $('#present-board');
		board.href = `/#/${encodeURIComponent(a)}/docs/${encodeURIComponent(b)}`;
		board.hidden = false;
	}
	shownVersion = doc.version;
	document.title = `${doc.title} - ${project.name}`;
	$('#present-project').textContent = project.name;
	$('#present-name').textContent = doc.title;
	$('#present-meta').textContent = `version ${doc.version} · updated ${ago(doc.updated)}`;
	$('#present-raw').href = raw;
	document.body.dataset.format = doc.format;
	$('#present-body').innerHTML = renderDoc(doc, raw);
}

$('#present-copy').addEventListener('click', async (e) => {
	const url = location.href;
	try {
		await navigator.clipboard.writeText(url);
		e.target.textContent = 'Copied';
	} catch {
		prompt('Copy this link:', url);
	}
	setTimeout(() => (e.target.textContent = 'Copy link'), 1200);
});

const STALE_MS = 40000; // the server pings every 15 s
const RETRY_MS = 5000;
let stream = null;
let lastHeard = 0;
let retryTimer = null;

function showDeleted() {
	$('#present-body').innerHTML = '<p class="hint">This doc was deleted.</p>';
}

// Whatever changed while the page was not listening. Only redraws on a new version: that resets the scroll and reloads
// an HTML doc's frame.
async function catchUp() {
	try {
		const doc = await getJson(`/api/projects/${encodeURIComponent(a)}/docs/${encodeURIComponent(b)}`);
		if (doc.version !== shownVersion) {
			await load();
		}
	} catch (e) {
		if (e.status === 404) {
			showDeleted();
		}
	}
}

function follow(reconnecting = false) {
	let greeted = reconnecting; // a hello after the first means the stream reconnected
	lastHeard = Date.now();
	const es = new EventSource(`/api/projects/${encodeURIComponent(a)}/events`);
	stream = es;
	es.onerror = () => {
		// The browser retries a dropped stream itself, but gives up for good on an error answer, like the proxy's 503
		// during a restart.
		if (es === stream && es.readyState === EventSource.CLOSED) {
			reconnect();
		}
	};
	es.onmessage = (m) => {
		lastHeard = Date.now();
		const ev = JSON.parse(m.data);
		if (ev.type === 'hello') {
			if (greeted) {
				catchUp();
			}
			greeted = true;
		} else if (ev.type === 'doc' && ev.id === b) {
			if (ev.action === 'delete') {
				showDeleted();
			} else {
				load().catch(() => {});
			}
		}
	};
}

function reconnect() {
	if (stream) {
		stream.close();
		stream = null;
	}
	clearTimeout(retryTimer);
	retryTimer = setTimeout(async () => {
		try {
			await getJson(`/api/projects/${encodeURIComponent(a)}`); // a lapsed sign-in goes to the login page from here
			follow(true);
		} catch {
			reconnect();
		}
	}, RETRY_MS);
}

// A stream can die without an error (a sleeping laptop, a frozen tab, a dropped network).
function checkStream() {
	if (stream && Date.now() - lastHeard > STALE_MS) {
		reconnect();
	}
}

load().then(() => {
	// Signed in: follow the doc live, so a presentation updates as Claude or you save it.
	if (!shared) {
		follow();
		setInterval(checkStream, 10000);
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) {
				checkStream();
			}
		});
	}
}).catch((e) => {
	$('#present-name').textContent = 'Not available';
	$('#present-body').innerHTML = `<p class="hint">${escHtml(e.message)}</p>`;
});
