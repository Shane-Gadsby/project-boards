'use strict';
// Project Boards page. Plain script, no build step. Everything the user does is sent with X-PB-Actor: user, which is
// what puts it in the project's inbox for Claude.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
	projects: [],
	slug: null,
	project: null,
	tasks: new Map(),
	handoffs: new Map(),
	tab: 'handoffs',
	es: null,
	showAllDone: false,
	openTask: null,
	drafts: new Map(), // "<handoff id>:<field>" -> text being typed, kept across re-renders
	clears: new Map(), // hand-off id -> times Clear answer was used on it, so a note still waiting to save cannot undo it
	neededBy: {}, // task id -> [{from, why, until, lastCheck}]: other projects waiting on it
	docs: new Map(), // id -> doc without content
	doc: null, // the open doc: {id, version (null = latest), record (with content)}
	docEdit: null, // while editing: {id (null = new), baseVersion, dirty, conflict}
};

// ---------------------------------------------------------------------------------------------------------------
// Helpers

function esc(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function el(html) {
	const t = document.createElement('template');
	t.innerHTML = html.trim();
	return t.content.firstElementChild;
}

function ago(iso) {
	if (!iso) {
		return '';
	}
	const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
	if (s < 60) {
		return 'just now';
	}
	if (s < 3600) {
		return `${Math.round(s / 60)} min ago`;
	}
	if (s < 86400) {
		return `${Math.round(s / 3600)} h ago`;
	}
	return `${Math.round(s / 86400)} d ago`;
}

async function api(method, path, body) {
	const res = await fetch(BASE + path, {
		method,
		headers: { 'Content-Type': 'application/json', 'X-PB-Actor': 'user' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (res.status === 401 && !path.startsWith('/api/auth/')) {
		// The session expired or was revoked (logins are required): sign in again and come back here.
		location.href = `${BASE}/login?next=${encodeURIComponent(location.pathname)}${location.hash}`;
		throw new Error('signing in again');
	}
	if (!res.ok) {
		const err = new Error(data.error || `${res.status}`);
		err.status = res.status;
		throw err;
	}
	return data;
}

function P(path = '') {
	return `/api/projects/${encodeURIComponent(state.slug)}${path}`;
}

function debounce(fn, ms) {
	let t = null;
	return (...a) => {
		clearTimeout(t);
		t = setTimeout(() => fn(...a), ms);
	};
}

function idCompare(a, b) {
	return String(a).localeCompare(String(b), undefined, { numeric: true });
}

// md() and renderDoc(): render.js (shared with the full-page doc view).

// ---------------------------------------------------------------------------------------------------------------
// Loading and live updates

async function loadProjects() {
	state.projects = await api('GET', '/api/projects');
	const sel = $('#project');
	const option = (p) => `<option value="${esc(p.slug)}">${esc(p.name)}${p.counts.waiting ? ` (${p.counts.waiting})` : ''}</option>`;
	const active = state.projects.filter((p) => !p.archived);
	const archived = state.projects.filter((p) => p.archived);
	sel.innerHTML = active.map(option).join('') + '<option value="__add">+ Add a project...</option>' +
		(archived.length ? `<optgroup label="Archived">${archived.map(option).join('')}</optgroup>` : '');
	if (state.slug) {
		sel.value = state.slug;
	}
}

const TABS = ['handoffs', 'tasks', 'docs'];

// #/<project>/<tab>, and #/<project>/docs/<doc id> for an open doc.
function routeFromHash() {
	const [, slug, tab, docId] = location.hash.split('/');
	return { slug: slug ? decodeURIComponent(slug) : null, tab: tab || null, docId: docId ? decodeURIComponent(docId) : null };
}

function setHash() {
	const h = `#/${encodeURIComponent(state.slug)}/${state.tab}${state.tab === 'docs' && state.doc && state.doc.id ? `/${encodeURIComponent(state.doc.id)}` : ''}`;
	if (location.hash !== h) {
		history.replaceState(null, '', h);
	}
	try {
		localStorage.setItem('pb.project', state.slug);
		localStorage.setItem('pb.tab', state.tab);
	} catch {
		// Storage can be unavailable; the hash still carries the choice.
	}
}

async function selectProject(slug) {
	if (state.es) {
		state.es.close();
		state.es = null;
	}
	state.slug = slug;
	state.tasks.clear();
	state.handoffs.clear();
	state.docs.clear();
	state.openTask = null;
	state.doc = null;
	state.docEdit = null;
	closeDrawer();
	$('#project').value = slug;
	setHash();
	await loadProject(slug);
	$('#empty').hidden = true;
	connectEvents();
	renderAll();
}

// Fill state from the server. False if the user moved to another project while this was loading.
async function loadProject(slug) {
	const [project, tasks, handoffs, watchers, docs] = await Promise.all([api('GET', P()), api('GET', P('/tasks')), api('GET', P('/handoffs')), api('GET', P('/watchers')), api('GET', P('/docs'))]);
	if (slug !== state.slug) {
		return false;
	}
	const known = state.tasks;
	state.project = project;
	state.neededBy = watchers.neededBy || {};
	state.docs = new Map(docs.map((d) => [String(d.id), d]));
	// The list leaves task bodies out; keep the ones already fetched.
	state.tasks = new Map(tasks.map((t) => [String(t.id), { ...t, body: t.body ?? known.get(String(t.id))?.body }]));
	state.handoffs = new Map(handoffs.map((h) => [String(h.id), h]));
	return true;
}

// Catch up on whatever happened while the page was not listening. Goes through scheduleRender, so a half-typed answer
// is not rebuilt; an open doc editor gets the usual conflict notice from docChanged.
async function resync() {
	const slug = state.slug;
	if (!slug || !(await loadProject(slug))) {
		return;
	}
	for (const what of ['header', 'handoffs', 'tasks', 'docs']) {
		scheduleRender(what);
	}
	if (state.openTask) {
		openTask(state.openTask, true);
	}
	if (state.doc && state.docs.has(state.doc.id)) {
		docChanged(state.doc.id, { record: state.docs.get(state.doc.id) });
	} else if (state.doc) {
		docChanged(state.doc.id, { action: 'delete' });
	}
}

const STALE_MS = 40000; // the server pings every 15 s
const RETRY_MS = 5000;
let connected = false; // has this project's stream said hello yet?
let lastHeard = 0;
let retryTimer = null;

function connectEvents(reconnecting = false) {
	clearTimeout(retryTimer);
	connected = reconnecting;
	lastHeard = Date.now();
	const es = new EventSource(BASE + P('/events'));
	state.es = es;
	const conn = $('#conn');
	es.onopen = () => conn.classList.add('live');
	es.onerror = () => {
		conn.classList.remove('live');
		// The browser retries a dropped stream itself, but gives up for good on an error answer, like the proxy's 503
		// during a restart.
		if (es === state.es && es.readyState === EventSource.CLOSED) {
			reconnectEvents();
		}
	};
	es.onmessage = (m) => {
		lastHeard = Date.now();
		const ev = JSON.parse(m.data);
		if (ev.type === 'hello') {
			state.waiters = ev.waiters || 0;
			renderNotify();
			if (connected) {
				resync().catch(() => {});
			}
			connected = true;
		} else if (ev.type === 'waiters') {
			state.waiters = ev.count;
			renderNotify();
		} else if (ev.type === 'task') {
			if (ev.action === 'delete') {
				state.tasks.delete(String(ev.id));
			} else {
				const prev = state.tasks.get(String(ev.id));
				// Events carry the full record; keep a body we already fetched if this one has it too.
				state.tasks.set(String(ev.id), { ...ev.record, body: ev.record.body ?? (prev && prev.body) });
			}
			scheduleRender('tasks');
			if (state.openTask === String(ev.id)) {
				openTask(state.openTask, true);
			}
		} else if (ev.type === 'handoff') {
			if (ev.action === 'delete') {
				state.handoffs.delete(String(ev.id));
			} else {
				state.handoffs.set(String(ev.id), { ...ev.record, state: handoffState(ev.record) });
			}
			scheduleRender('handoffs');
		} else if (ev.type === 'doc') {
			if (ev.action === 'delete') {
				state.docs.delete(String(ev.id));
			} else {
				state.docs.set(String(ev.id), ev.record);
			}
			docChanged(String(ev.id), ev);
			scheduleRender('docs');
		} else if (ev.type === 'watchers') {
			state.neededBy = ev.record || {};
			scheduleRender('tasks');
			if (state.openTask) {
				openTask(state.openTask);
			}
		} else if (ev.type === 'project' && ev.action === 'delete') {
			projectGone().catch(() => {});
		} else if (ev.type === 'project' && ev.record) {
			state.project = { ...state.project, ...ev.record, archived: ev.record.archived };
			scheduleRender('header');
			scheduleRender('handoffs');
			loadProjects().catch(() => {});
		}
	};
}

// This project was deleted, here or in another tab: move to another one.
async function projectGone() {
	if (state.es) {
		state.es.close();
		state.es = null;
	}
	await loadProjects();
	const next = state.projects.filter((p) => !p.archived)[0];
	if (next) {
		await selectProject(next.slug);
	} else {
		location.hash = '';
		location.reload();
	}
}

function reconnectEvents() {
	if (state.es) {
		state.es.close();
		state.es = null;
	}
	$('#conn').classList.remove('live');
	clearTimeout(retryTimer);
	retryTimer = setTimeout(async () => {
		try {
			await api('GET', P()); // a lapsed sign-in goes to the login page from here
			if (!state.es) {
				connectEvents(true);
			}
		} catch (e) {
			if (e.status === 404) {
				projectGone().catch(() => {});
			} else {
				reconnectEvents();
			}
		}
	}, RETRY_MS);
}

// A stream can die without an error (a sleeping laptop, a frozen tab, a dropped network).
function checkEvents() {
	if (state.es && Date.now() - lastHeard > STALE_MS) {
		reconnectEvents();
	}
}
setInterval(checkEvents, 10000);
document.addEventListener('visibilitychange', () => {
	if (!document.hidden) {
		checkEvents();
	}
});

function renderNotify() {
	const answered = [...state.handoffs.values()].filter((h) => handoffState(h) === 'answered').length;
	$('#notify-bar').hidden = answered === 0;
	const n = state.waiters || 0;
	$('#notify-sessions').disabled = n === 0;
	$('#notify-status').textContent = n === 0
		? 'No session is waiting right now. Sessions see these the next time they check their inbox.'
		: `${n} session${n === 1 ? ' is' : 's are'} waiting. They are told anyway a minute after your last answer.`;
}

const pending = new Set();
let handoffsDeferred = false;
document.addEventListener('focusout', (e) => {
	if (handoffsDeferred && e.target.matches('.card textarea')) {
		scheduleRender('handoffs');
	}
});
function scheduleRender(what) {
	pending.add(what);
	requestAnimationFrame(() => {
		if (pending.size === 0) {
			return;
		}
		const w = new Set(pending);
		pending.clear();
		if (w.has('header')) {
			renderHeader();
		}
		if (w.has('handoffs')) {
			// A save can move a card to another section (pending -> answered), which would rebuild it and drop focus,
			// so hold handoff renders while a card's textarea is being typed in and catch up on focusout.
			if (document.activeElement && document.activeElement.matches('.card textarea')) {
				handoffsDeferred = true;
			} else {
				renderHandoffs();
			}
		}
		if (w.has('tasks')) {
			renderTasks();
		}
		if (w.has('docs')) {
			renderDocList();
		}
		renderBadges();
	});
}

// Keep in step with hasAnswer() in server.js.
function hasAnswer(h) {
	const said = (v) => String(v ?? '').trim() !== '';
	return said(h.answer) || said(h.note) || Object.values(h.stepAnswers || {}).some((s) => s && (s.state || said(s.note)));
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
	return h.ackedAt && h.ackedAt >= h.userUpdatedAt ? 'acted' : 'answered';
}

// ---------------------------------------------------------------------------------------------------------------
// Rendering

function renderAll() {
	renderHeader();
	renderTabs();
	renderHandoffs();
	renderTasks();
	renderDocs();
	renderBadges();
}

function renderHeader() {
	const p = state.project;
	if (!p) {
		return;
	}
	const banner = $('#banner');
	banner.hidden = !p.banner;
	banner.textContent = p.banner || '';
	const active = [...state.tasks.values()].filter((t) => t.status === 'active');
	$('#agents').textContent = `Sub-agents: up to ${p.maxSubagents}  |  ${active.length} being worked on`;
	document.body.classList.toggle('archived', !!p.archived);
	$('#archived-banner').hidden = !p.archived;
}

function renderTabs() {
	for (const b of $$('.tab')) {
		b.classList.toggle('active', b.dataset.tab === state.tab);
	}
	$('#tab-handoffs').hidden = state.tab !== 'handoffs';
	$('#tab-tasks').hidden = state.tab !== 'tasks';
	$('#tab-docs').hidden = state.tab !== 'docs';
}

function renderBadges() {
	const waiting = [...state.handoffs.values()].filter((h) => h.visible !== false && handoffState(h) === 'pending' && h.kind !== 'info').length;
	$('#badge-handoffs').textContent = waiting || '';
	const active = [...state.tasks.values()].filter((t) => t.status === 'active').length;
	$('#badge-tasks').textContent = active ? `${active} active` : '';
	$('#badge-docs').textContent = state.docs.size || '';
	document.title = waiting ? `(${waiting}) Project Boards` : 'Project Boards';
}

// Replace a container's children with rendered items, reusing a node when its record's version is unchanged and
// never replacing a node being typed in (so typing is not lost when an update arrives). A focused button does not
// count: it holds focus after every click, and keeping its card would show the answer from before the click.
function renderKeyed(container, items, key, version, render) {
	const old = new Map($$(':scope > [data-key]', container).map((n) => [n.dataset.key, n]));
	const nodes = [];
	for (const item of items) {
		const k = key(item);
		const v = version(item);
		const prev = old.get(k);
		if (prev && (prev.dataset.ver === v || (prev.contains(document.activeElement) && document.activeElement.matches('textarea, input')))) {
			nodes.push(prev);
			continue;
		}
		const n = render(item);
		n.dataset.key = k;
		n.dataset.ver = v;
		nodes.push(n);
	}
	placeChildren(container, nodes);
}

// Make container's children exactly `nodes`, in order, only touching the ones out of place. replaceChildren would
// detach every child first, and detaching the focused element blurs it even if it is put straight back.
function placeChildren(container, nodes) {
	let cursor = container.firstChild;
	for (const n of nodes) {
		if (n === cursor) {
			cursor = cursor.nextSibling;
			continue;
		}
		container.insertBefore(n, cursor);
	}
	while (cursor) {
		const next = cursor.nextSibling;
		cursor.remove();
		cursor = next;
	}
}

function lanes() {
	return (state.project && state.project.lanes) || [];
}

function renderHandoffs() {
	renderNotify();
	handoffsDeferred = false;
	if (!state.project) {
		return;
	}
	const all = [...state.handoffs.values()].map((h) => ({ ...h, state: handoffState(h) }));
	const visible = all.filter((h) => h.visible !== false);
	const byOrder = (a, b) => (a.order || 0) - (b.order || 0) || idCompare(a.id, b.id);
	const waiting = visible.filter((h) => h.state === 'pending').sort(byOrder);
	const answered = all.filter((h) => h.state === 'answered').sort((a, b) => (a.userUpdatedAt < b.userUpdatedAt ? 1 : -1));
	const filter = $('#done-filter').value.trim().toLowerCase();
	const acted = all.filter((h) => h.state === 'acted' && (!filter || JSON.stringify([h.id, h.title, h.question, h.answer, h.note]).toLowerCase().includes(filter)))
		.sort((a, b) => ((a.ackedAt || '') < (b.ackedAt || '') ? 1 : -1));

	// Waiting: one column per lane (plus "Shared" for items without one), or a single list.
	const wrap = $('#waiting');
	const ls = lanes();
	const groups = ls.length ? [...ls.map((l) => ({ id: l.id, name: l.name })), { id: '', name: 'Shared' }] : [{ id: '', name: '' }];
	const busy = state.project.busy || {};
	const laneNodes = groups.map((g) => {
		const items = waiting.filter((h) => (ls.length ? (h.lane || '') === g.id || (!g.id && !ls.some((l) => l.id === h.lane)) : true));
		if (ls.length && !g.id && items.length === 0 && !busy.all) {
			return null;
		}
		let lane = wrap.querySelector(`:scope > .lane[data-lane="${CSS.escape(g.id)}"]`);
		if (!lane) {
			lane = el(`<div class="lane" data-lane="${esc(g.id)}">${g.name ? `<h3>${esc(g.name)}</h3>` : ''}<div class="busy" hidden></div><div class="cards"></div></div>`);
		}
		const b = busy[g.id] || (g.id === '' ? busy.all : null);
		const bn = $('.busy', lane);
		bn.hidden = !b;
		bn.textContent = b ? `Claude is using this: ${b.text}${b.since ? ` (since ${ago(b.since)})` : ''}. Please leave it alone.` : '';
		const cards = $('.cards', lane);
		renderKeyed(cards, items, (h) => h.id, (h) => `${h.version}:${h.state}`, renderHandoffCard);
		if (items.length === 0) {
			cards.replaceChildren(el('<div class="none">Nothing waiting.</div>'));
		}
		return lane;
	}).filter(Boolean);
	placeChildren(wrap, laneNodes);
	$('#count-waiting').textContent = waiting.length ? `(${waiting.length})` : '';

	renderKeyed($('#answered'), answered, (h) => h.id, (h) => `${h.version}:${h.state}`, renderHandoffCard);
	if (!answered.length) {
		$('#answered').replaceChildren(el('<div class="none">Nothing waiting on Claude.</div>'));
	}
	$('#count-answered').textContent = answered.length ? `(${answered.length})` : '';
	const shown = acted.slice(0, 200);
	renderKeyed($('#acted'), shown, (h) => h.id, (h) => `${h.version}:${h.state}`, renderHandoffCard);
	$('#count-acted').textContent = `(${all.filter((h) => h.state === 'acted').length})`;
}

function statusLine(h) {
	if (h.kind === 'message') {
		return h.state === 'acted' ? `<div class="status-line ok">Claude has read this ${ago(h.ackedAt)}${h.ackNote ? `: ${esc(h.ackNote)}` : ''}</div>` : `<div class="status-line">Sent ${ago(h.userUpdatedAt)}; Claude has not read it yet</div>`;
	}
	if (h.state === 'acted') {
		return `<div class="status-line ok">Claude picked this up ${ago(h.ackedAt)}${h.ackNote ? `: ${esc(h.ackNote)}` : ''}</div><div class="status-line">Changing or clearing this tells Claude again.</div>`;
	}
	if (h.state === 'answered') {
		return `<div class="status-line">Answered ${ago(h.userUpdatedAt)}; Claude has not picked it up yet (you can still change or clear it)</div>`;
	}
	if (h.userUpdatedAt && (!h.ackedAt || h.userUpdatedAt > h.ackedAt)) {
		return `<div class="status-line">You cleared your answer ${ago(h.userUpdatedAt)}; Claude has not seen that yet</div>`;
	}
	return '';
}

function renderHandoffCard(h) {
	const n = el(`<article class="card ${h.state} ${h.kind === 'message' ? 'message' : ''}"></article>`);
	const meta = [h.kind !== 'choice' ? `<span class="tag">${esc(h.kind)}</span>` : '', h.lane ? `<span class="tag">${esc((lanes().find((l) => l.id === h.lane) || {}).name || h.lane)}</span>` : '',
		h.source ? `<span>${esc(h.source)}</span>` : '', `<span>${esc(ago(h.created))}</span>`].filter(Boolean).join('');
	let html = `<h4>${esc(h.title || (h.kind === 'message' ? 'Message' : h.question))}</h4><div class="meta">${meta}</div>`;
	if (h.question && h.title) {
		html += `<div class="question">${esc(h.question)}</div>`;
	} else if (h.question && h.kind === 'message') {
		html += `<div class="question">${esc(h.question)}</div>`;
	}
	if (h.context) {
		html += `<div class="context">${esc(h.context)}</div>`;
	}
	if (h.media && h.media.length) {
		// Videos get wide columns (their controls disappear when narrow) and an Enlarge button; several videos also get
		// a side-by-side comparison, since a click on a video belongs to its own controls.
		const videos = h.media.filter((m) => m.url && m.kind === 'video').length;
		const figure = (m) => {
			if (!m.url) {
				return `<figure><div class="none">(media not available)</div>${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`;
			}
			if (m.kind === 'video') {
				return `<figure class="vid" data-caption="${esc(m.caption)}"><video src="${esc(mediaUrl(m.url))}" muted controls playsinline preload="metadata"></video><figcaption>${esc(m.caption)}<button type="button" class="enlarge">Enlarge</button></figcaption></figure>`;
			}
			return `<figure><img src="${esc(mediaUrl(m.url))}" alt="${esc(m.caption)}" loading="lazy">${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`;
		};
		html += `<div class="media${videos ? ' has-video' : ''}">${h.media.map(figure).join('')}${videos > 1 ? `<button type="button" class="compare">Compare the ${videos} videos side by side</button>` : ''}</div>`;
	}
	n.innerHTML = html;

	if (h.kind === 'choice' || h.kind === 'look') {
		const box = el('<div class="choices"></div>');
		for (const c of h.choices || []) {
			const isDefault = h.default && c.label === h.default;
			const b = el(`<button type="button" class="choice${isDefault ? ' default' : ''}${h.answer === c.label ? ' selected' : ''}">${esc(c.label)}${isDefault ? ' <span class="tag default">default</span>' : ''}${c.detail ? `<span class="detail">${esc(c.detail)}</span>` : ''}</button>`);
			b.addEventListener('click', () => answer(h.id, { answer: h.answer === c.label ? null : c.label }));
			box.append(b);
		}
		n.append(box);
		n.append(noteBox(h, 'note', 'Note (optional)'));
	} else if (h.kind === 'text') {
		n.append(noteBox(h, 'answer', 'Your answer'));
		n.append(noteBox(h, 'note', 'Note (optional)'));
	} else if (h.kind === 'steps') {
		const ol = el('<ol class="steps"></ol>');
		(h.steps || []).forEach((s, i) => {
			const a = (h.stepAnswers || {})[i] || {};
			const li = el(`<li class="step"><div class="do">${i + 1}. ${esc(s.do)}</div>${s.expect ? `<div class="expect">Should happen: ${esc(s.expect)}</div>` : ''}<div class="step-buttons"></div></li>`);
			for (const [st, label] of [['good', 'Looks good'], ['blocked', 'Blocked, see notes'], ['work', 'Needs work, see notes']]) {
				const b = el(`<button type="button" class="${a.state === st ? `sel-${st}` : ''}">${label}</button>`);
				b.addEventListener('click', () => answer(h.id, { step: i, state: a.state === st ? null : st }));
				$('.step-buttons', li).append(b);
			}
			li.append(noteBox(h, `step:${i}`, 'Notes for this step', a.note || ''));
			ol.append(li);
		});
		n.append(ol);
	} else if (h.kind === 'info') {
		const row = el('<div class="actions"><button type="button">Dismiss</button></div>');
		$('button', row).addEventListener('click', () => api('PATCH', P(`/handoffs/${encodeURIComponent(h.id)}`), { visible: false }).catch(alert));
		n.append(row);
	}
	if (['choice', 'look', 'text', 'steps'].includes(h.kind) && hasAnswer(h)) {
		const row = el('<div class="actions"><button type="button">Clear answer</button></div>');
		$('button', row).addEventListener('click', () => clearAnswer(h));
		n.append(row);
	}
	n.insertAdjacentHTML('beforeend', statusLine(h));
	return n;
}

// A note/answer textarea that saves as it is typed (debounced) and keeps its draft across re-renders.
function noteBox(h, field, placeholder, current) {
	const key = `${h.id}:${field}`;
	const value = state.drafts.has(key) ? state.drafts.get(key) : current ?? (field === 'answer' ? h.answer : h.note) ?? '';
	const ta = el(`<textarea class="note" rows="${field === 'answer' ? 3 : 2}" placeholder="${esc(placeholder)}"></textarea>`);
	ta.value = value;
	const clears = state.clears.get(h.id);
	const save = debounce(() => {
		if (state.clears.get(h.id) !== clears) {
			return; // the answer was cleared while this waited to save; do not bring it back
		}
		const text = ta.value;
		const body = field.startsWith('step:') ? { step: Number(field.slice(5)), note: text } : { [field]: text };
		answer(h.id, body).then(() => state.drafts.delete(key));
	}, 700);
	ta.addEventListener('input', () => {
		state.drafts.set(key, ta.value);
		save();
	});
	return ta;
}

function clearAnswer(h) {
	if (!confirm('Clear your answer and notes on this hand-off? It goes back to Waiting, and Claude is told.')) {
		return;
	}
	state.clears.set(h.id, (state.clears.get(h.id) || 0) + 1);
	for (const key of [...state.drafts.keys()]) {
		if (key.startsWith(`${h.id}:`)) {
			state.drafts.delete(key);
		}
	}
	answer(h.id, { clear: true });
}

async function answer(id, body) {
	try {
		await api('POST', P(`/handoffs/${encodeURIComponent(id)}/answer`), body);
	} catch (e) {
		alert(`Could not save: ${e.message}`);
	}
}

function renderTasks() {
	if (!state.project) {
		return;
	}
	const filter = $('#task-filter').value.trim().toLowerCase();
	const tasks = [...state.tasks.values()].filter((t) => !filter || `${t.id} ${t.title} ${t.owner} ${t.state} ${t.branch}`.toLowerCase().includes(filter));
	for (const col of $$('.column')) {
		const status = col.dataset.status;
		let items = tasks.filter((t) => t.status === status);
		if (status === 'todo') {
			items.sort((a, b) => idCompare(a.id, b.id));
		} else {
			items.sort((a, b) => ((a.updated || '') < (b.updated || '') ? 1 : -1));
		}
		$('.count', col).textContent = `(${items.length})`;
		const more = $('.more', col);
		if (more) {
			const limit = 60;
			more.hidden = state.showAllDone || items.length <= limit || !!filter;
			more.textContent = `Show all ${items.length}`;
			if (!state.showAllDone && !filter) {
				items = items.slice(0, limit);
			}
		}
		renderKeyed($('.col-cards', col), items, (t) => String(t.id), (t) => `${t.version}:${neededBy(t).map((w) => w.from).join(',')}`, renderTaskCard);
		if (!items.length) {
			$('.col-cards', col).replaceChildren(el('<div class="none">None.</div>'));
		}
	}
	renderHeader();
}

function neededBy(t) {
	return state.neededBy[String(t.id)] || [];
}

function renderTaskCard(t) {
	// Finished work stays listed in the drawer; the card tag is for what someone is still waiting on.
	const from = t.status === 'done' ? [] : [...new Set(neededBy(t).map((w) => w.from))];
	const needed = from.length ? `<span class="tag needed" title="${esc(neededBy(t).map((w) => `${w.from}${w.why ? `: ${w.why}` : ''}`).join('\n'))}">needed by ${esc(from.join(', '))}</span>` : '';
	const n = el(`<div class="task" tabindex="0">
		<div><span class="tid">#${esc(t.id)}</span><span class="ttitle">${esc(t.title)}</span></div>
		<div class="tmeta"><span class="state" title="${esc(t.state)}">${esc(t.state || t.status)}</span>${t.owner ? `<span>${esc(t.owner)}</span>` : ''}<span>${esc(ago(t.updated))}</span>${needed}</div>
	</div>`);
	const open = () => openTask(String(t.id));
	n.addEventListener('click', open);
	n.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') {
			open();
		}
	});
	return n;
}

async function openTask(id, refresh = false) {
	state.openTask = id;
	let t = state.tasks.get(id);
	if (!t || t.body === undefined || refresh) {
		try {
			t = await api('GET', P(`/tasks/${encodeURIComponent(id)}`));
			state.tasks.set(id, t);
		} catch (e) {
			alert(e.message);
			return;
		}
	}
	const drawer = $('#drawer');
	$('#drawer-title').textContent = `#${t.id} ${t.title}`;
	const kv = [['Column', { todo: 'Not started', active: 'Being worked on', done: 'Complete' }[t.status]], ['State', t.state], ['Owner', t.owner], ['Claimed', t.claimed],
		['Branch', t.branch], ['Results', t.results], ['Needs', t.needs], ['Needed by', neededBy(t).map((w) => `${w.from}${w.until !== 'done' ? ` (until ${w.until})` : ''}${w.why ? `: ${w.why}` : ''} (checked ${ago(w.lastCheck)})`).join('\n')],
		['File', t.file], ['Updated', t.updated ? `${new Date(t.updated).toLocaleString()} (${ago(t.updated)})` : '']]
		.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('');
	const log = (t.log || []).map((l) => `<div>${esc(new Date(l.at).toLocaleString())} &middot; ${esc(l.by)}: ${esc(l.text)}</div>`).join('');
	$('#drawer-body').innerHTML = `<dl class="kv">${kv}</dl>
		<div class="edit-row"><input name="state" value="${esc(t.state)}" aria-label="State"><button type="button" id="save-state">Set state</button>
		<select id="set-status" aria-label="Column"><option value="">Column from state</option><option value="todo">Not started</option><option value="active">Being worked on</option><option value="done">Complete</option></select></div>
		${log ? `<div class="log">${log}</div>` : ''}
		<div class="md">${t.body ? md(t.body) : '<p class="hint">No details.</p>'}</div>`;
	$('#set-status').value = t.statusLocked ? t.status : '';
	$('#save-state').addEventListener('click', () => {
		const body = { state: $('input[name="state"]', drawer).value };
		const st = $('#set-status').value;
		if (st) {
			body.status = st;
		} else {
			body.statusLocked = false;
		}
		api('PATCH', P(`/tasks/${encodeURIComponent(t.id)}`), body).catch((e) => alert(e.message));
	});
	drawer.hidden = false;
}

function closeDrawer() {
	$('#drawer').hidden = true;
	state.openTask = null;
}

// ---------------------------------------------------------------------------------------------------------------
// Settings, adding projects and tasks

function openSettings() {
	const p = state.project;
	if (!p) {
		return;
	}
	const f = $('#settings-form');
	f.name.value = p.name;
	f.path.value = p.path || '';
	f.description.value = p.description || '';
	f.maxSubagents.innerHTML = Array.from({ length: 11 }, (_, i) => `<option value="${i}">${i}${i === 0 ? ' (none)' : ''}</option>`).join('');
	f.maxSubagents.value = String(p.maxSubagents);
	f.lanes.value = (p.lanes || []).map((l) => l.name).join(', ');
	f.banner.value = p.banner || '';
	$('#onboard-url').textContent = `${location.origin}${BASE}/onboard/${p.slug}`;
	$('#settings').showModal();
}

async function saveSettings() {
	const f = $('#settings-form');
	const lanesText = f.lanes.value.split(',').map((s) => s.trim()).filter(Boolean);
	const prev = (state.project.lanes || []).map((l) => l.name).join(',');
	const body = { name: f.name.value, path: f.path.value, description: f.description.value, maxSubagents: Number(f.maxSubagents.value), banner: f.banner.value };
	if (lanesText.join(',') !== prev) {
		body.lanes = lanesText;
	}
	state.project = await api('PATCH', P(), body);
	await loadProjects();
	renderAll();
}

async function init() {
	for (const n of $$('.enrol-url')) {
		n.textContent = `${location.origin}${BASE}/enrol`;
	}
	for (const b of $$('.copy-enrol')) {
		b.addEventListener('click', () => copyText(`${location.origin}${BASE}/enrol`, b));
	}
	await renderSignInOut().catch(() => {});
	await loadProjects();
	const r = routeFromHash();
	let stored = null;
	try {
		stored = { slug: localStorage.getItem('pb.project'), tab: localStorage.getItem('pb.tab') };
	} catch {
		stored = {};
	}
	state.tab = r.tab || stored.tab || 'handoffs';
	if (!TABS.includes(state.tab)) {
		state.tab = 'handoffs';
	}
	const slug = [r.slug, stored.slug].find((s) => s && state.projects.some((p) => p.slug === s)) || (state.projects.filter((p) => !p.archived)[0] && state.projects[0].slug);
	renderTabs();
	if (!slug) {
		$('#tab-handoffs').hidden = true;
		$('#empty').hidden = false;
		$('#empty').innerHTML = `No projects yet. Add one from the menu, or give a Claude session <code>${esc(location.origin + BASE)}/enrol</code>.`;
		return;
	}
	await selectProject(slug);
	if (state.tab === 'docs' && r.docId) {
		await openDoc(r.docId);
	}
}

$('#project').addEventListener('change', (e) => {
	if (e.target.value === '__add') {
		e.target.value = state.slug || '';
		$('#add-project').showModal();
		return;
	}
	selectProject(e.target.value).catch((err) => alert(err.message));
});
for (const b of $$('.tab')) {
	b.addEventListener('click', () => {
		if (state.tab === 'docs' && b.dataset.tab !== 'docs' && !leaveEditor()) {
			return;
		}
		state.tab = b.dataset.tab;
		setHash();
		renderTabs();
	});
}
$('#open-settings').addEventListener('click', () => {
	openSettings();
	$('#danger-zone').hidden = state.slug === 'project-boards';
	$('#archive-project').textContent = state.project.archived ? 'Restore project' : 'Archive project';
});

async function setArchived(archived) {
	await api('POST', P(archived ? '/archive' : '/unarchive'), {});
	state.project = await api('GET', P());
	await loadProjects();
	renderHeader();
	renderHandoffs();
}
$('#archive-project').addEventListener('click', () => {
	$('#settings').close();
	setArchived(!state.project.archived).catch((err) => alert(err.message));
});
$('#restore-project').addEventListener('click', () => setArchived(false).catch((err) => alert(err.message)));
$('#open-delete-project').addEventListener('click', () => {
	const n = (count, word) => `${count || 0} ${word}${count === 1 ? '' : 's'}`;
	$('#delete-project-name').textContent = state.project.name;
	$('#delete-project-counts').textContent = `${n(state.tasks.size, 'task')}, ${n(state.handoffs.size, 'hand-off')} and ${n(state.docs.size, 'doc')}`;
	$('#delete-project-slug').textContent = state.slug;
	$('#delete-project-form').confirm.value = '';
	$('#delete-project-confirm').disabled = true;
	$('#settings').close();
	$('#delete-project').showModal();
});
$('#delete-project-form').confirm.addEventListener('input', (e) => {
	$('#delete-project-confirm').disabled = e.target.value !== state.slug;
});
$('#delete-project-form').addEventListener('submit', async (e) => {
	if (e.submitter && e.submitter.value === 'delete') {
		const confirm = e.target.confirm.value;
		e.preventDefault();
		try {
			await api('DELETE', P(), { confirm });
			$('#delete-project').close();
			await projectGone();
		} catch (err) {
			alert(err.message);
		}
	}
});

// ---------------------------------------------------------------------------------------------------------------
// Docs: the list, the viewer (any version), the editor, history and share links

const DOC_FORMATS = ['markdown', 'html', 'svg', 'json', 'csv', 'code', 'text'];

function docRawUrl(id, version) {
	return BASE + P(`/docs/${encodeURIComponent(id)}/raw?version=${version}`);
}

function byWhom(actor) {
	return actor === 'user' ? 'you' : actor || '';
}

// The user edited it and Claude has not read it since (pb inbox lists these).
function unseenByClaude(d) {
	return d.userUpdatedAt && (!d.seenAt || d.userUpdatedAt > d.seenAt);
}

function renderDocs() {
	renderDocList();
	renderDocPane();
}

function renderDocList() {
	const filter = $('#doc-filter').value.trim().toLowerCase();
	const docs = [...state.docs.values()].filter((d) => !filter || `${d.id} ${d.title} ${d.summary} ${(d.tags || []).join(' ')}`.toLowerCase().includes(filter))
		.sort((a, b) => (a.updated < b.updated ? 1 : -1));
	const open = state.doc && state.doc.id;
	const nodes = docs.map((d) => {
		const n = el(`<button type="button" class="doc-item${d.id === open ? ' active' : ''}">
			<span class="doc-title">${esc(d.title)}</span>
			<span class="doc-meta"><span class="tag">${esc(d.format === 'code' && d.language ? d.language : d.format)}</span>${(d.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}${d.share ? '<span class="tag shared">shared</span>' : ''}${unseenByClaude(d) ? '<span class="tag needed">Claude has not read your edit</span>' : ''}<span>v${d.version} · ${esc(ago(d.updated))} · ${esc(byWhom(d.updatedBy))}</span></span>
		</button>`);
		n.addEventListener('click', () => openDoc(d.id));
		return n;
	});
	$('#doc-list').replaceChildren(...(nodes.length ? nodes : [el(`<div class="none">${state.docs.size ? 'No doc matches.' : 'No docs yet. Make one with New doc; Claude sessions add them with <code>pb doc put &lt;file&gt;</code>.'}</div>`)]));
}

async function openDoc(id, version = null) {
	if (!leaveEditor()) {
		return;
	}
	state.docEdit = null;
	try {
		const rec = await api('GET', P(`/docs/${encodeURIComponent(id)}${version ? `?version=${version}` : ''}`));
		state.doc = { id, version, record: rec };
	} catch (e) {
		state.doc = null;
		alert(e.message);
	}
	state.tab = 'docs';
	setHash();
	renderTabs();
	renderDocs();
}

// A live event for a doc: refresh what is shown, but never under an open editor (say so instead).
function docChanged(id, ev) {
	if (!state.doc || state.doc.id !== id) {
		return;
	}
	if (ev.action === 'delete') {
		if (state.docEdit) {
			state.docEdit.conflict = 'deleted';
			showEditConflict();
		} else {
			state.doc = null;
			renderDocPane();
		}
		return;
	}
	if (state.docEdit) {
		// Our own save's echo can arrive before its answer does.
		if (!state.docEdit.saving && ev.record.version !== state.docEdit.baseVersion) {
			state.docEdit.conflict = ev.record;
			showEditConflict();
		}
		return;
	}
	if (!state.doc.version) {
		openDoc(id);
	}
}

function renderDocPane() {
	const pane = $('#doc-pane');
	if (state.docEdit) {
		return; // the editor stays as the user left it
	}
	if (!state.doc) {
		pane.replaceChildren(el(`<div class="none doc-empty">Pick a doc on the left, or make one with <strong>New doc</strong>.<br>Docs are documents for this project: specs, reports, notes, diagrams (SVG), pages (HTML), data (JSON, CSV). Claude sessions write them with <code>pb doc put</code>; you can edit them here and present or share them.</div>`));
		return;
	}
	const d = state.doc.record;
	const latest = state.docs.get(state.doc.id) || d;
	const signedIn = state.me && state.me.signedIn && state.me.kind === 'session';
	const head = el(`<div class="doc-head">
		<div class="doc-head-text"><h2>${esc(d.title)}</h2>
			<div class="doc-meta"><span class="tag">${esc(d.format === 'code' && d.language ? d.language : d.format)}</span>${(d.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join('')}<span>version ${d.version} · ${esc(ago(d.updated))} by ${esc(byWhom(d.updatedBy))} · ${Math.ceil((d.size || 0) / 1024)} KB</span></div>
			${d.summary ? `<div class="hint">${esc(d.summary)}</div>` : ''}
		</div>
		<div class="doc-actions">
			<button type="button" data-act="edit">Edit</button>
			<a class="button" href="${BASE}/d/${encodeURIComponent(state.slug)}/${encodeURIComponent(d.id)}" target="_blank" rel="noopener">Present</a>
			<a class="button" href="${esc(docRawUrl(d.id, d.version))}" target="_blank" rel="noopener">Raw</a>
			<button type="button" data-act="history">History</button>
			${signedIn ? `<button type="button" data-act="share">${latest.share ? 'Shared' : 'Share'}</button>` : ''}
			<button type="button" data-act="delete">Delete</button>
		</div>
	</div>`);
	const parts = [head];
	if (d.old) {
		const banner = el(`<div class="doc-banner">You are looking at version ${d.version}; the latest is ${d.latest}. <button type="button" data-act="latest">Back to the latest</button> <button type="button" data-act="restore">Restore this version</button></div>`);
		parts.push(banner);
	}
	if (latest.share) {
		parts.push(el(`<div class="doc-banner share">Anyone with this link can read it, without signing in: <code>${esc(location.origin + BASE)}/s/${esc(latest.share)}</code> <button type="button" data-act="copy-share">Copy</button> <button type="button" data-act="unshare">Stop sharing</button></div>`));
	}
	parts.push(el(`<div class="doc-body format-${esc(d.format)}">${renderDoc(d, docRawUrl(d.id, d.version))}</div>`));
	pane.replaceChildren(...parts);
	pane.onclick = (e) => {
		const act = e.target.closest('[data-act]');
		if (act) {
			docAction(act.dataset.act).catch((err) => alert(err.message));
		}
	};
}

async function docAction(act) {
	const d = state.doc.record;
	const id = state.doc.id;
	if (act === 'edit') {
		const latest = d.old ? await api('GET', P(`/docs/${encodeURIComponent(id)}`)) : d;
		startEdit(latest);
	} else if (act === 'history') {
		await showDocHistory(id);
	} else if (act === 'latest') {
		await openDoc(id);
	} else if (act === 'restore') {
		await api('PUT', P(`/docs/${encodeURIComponent(id)}`), { title: d.title, format: d.format, language: d.language, content: d.content, note: `restored version ${d.version}` });
		await openDoc(id);
	} else if (act === 'share') {
		const latest = state.docs.get(id);
		if (!latest.share) {
			await api('POST', P(`/docs/${encodeURIComponent(id)}/share`));
		}
	} else if (act === 'copy-share') {
		copyText(`${location.origin}${BASE}/s/${state.docs.get(id).share}`);
	} else if (act === 'unshare') {
		await api('DELETE', P(`/docs/${encodeURIComponent(id)}/share`));
	} else if (act === 'delete') {
		if (confirm(`Delete "${d.title}" and its history? This cannot be undone.`)) {
			await api('DELETE', P(`/docs/${encodeURIComponent(id)}`));
			state.doc = null;
			setHash();
			renderDocs();
		}
	}
}

async function showDocHistory(id) {
	const list = await api('GET', P(`/docs/${encodeURIComponent(id)}/history`));
	$('#doc-history-title').textContent = `History: ${state.docs.get(id).title}`;
	const rows = list.map((h) => {
		const tr = el(`<tr><td>v${h.version}</td><td>${esc(new Date(h.at).toLocaleString())} (${esc(ago(h.at))})</td><td>${esc(byWhom(h.by))}</td><td>${esc(h.note || '')}</td><td>${Math.ceil(h.size / 1024)} KB</td><td><button type="button">View</button></td></tr>`);
		$('button', tr).addEventListener('click', () => {
			$('#doc-history').close();
			openDoc(id, h.version);
		});
		return tr;
	});
	$('#doc-history-table').replaceChildren(el('<tr><th>Version</th><th>Saved</th><th>By</th><th>Note</th><th>Size</th><th></th></tr>'), ...rows);
	$('#doc-history').showModal();
}

function startEdit(rec) {
	state.docEdit = { id: rec ? rec.id : null, baseVersion: rec ? rec.version : null, dirty: false, conflict: null };
	const r = rec || { title: '', format: 'markdown', language: '', tags: [], content: '' };
	const pane = $('#doc-pane');
	pane.onclick = null;
	const form = el(`<form class="doc-edit">
		<div class="edit-grid">
			<label>Title <input name="title" required value="${esc(r.title)}"></label>
			<label>Format <select name="format">${DOC_FORMATS.map((f) => `<option${f === r.format ? ' selected' : ''}>${f}</option>`).join('')}</select></label>
			<label class="lang">Language <input name="language" value="${esc(r.language || '')}" placeholder="e.g. gdscript"></label>
			<label>Tags <input name="tags" value="${esc((r.tags || []).join(', '))}" placeholder="comma separated"></label>
		</div>
		<div class="edit-conflict" hidden></div>
		<div class="edit-split"><textarea name="content" spellcheck="false"></textarea><div class="doc-preview doc-body" hidden></div></div>
		<div class="edit-bar">
			<input name="note" placeholder="What changed (optional, kept in the history)">
			<label class="inline"><input type="checkbox" name="preview"> Preview</label>
			<span class="spacer"></span>
			<button type="button" data-act="cancel">Cancel</button>
			<button type="submit" class="primary">${rec ? 'Save' : 'Create'}</button>
		</div>
	</form>`);
	form.content.value = r.content || '';
	const syncLang = () => {
		$('.lang', form).hidden = form.format.value !== 'code';
	};
	syncLang();
	const preview = debounce(() => {
		const box = $('.doc-preview', form);
		box.hidden = !form.preview.checked;
		if (!form.preview.checked) {
			return;
		}
		const doc = { title: form.title.value, format: form.format.value, language: form.language.value, content: form.content.value };
		if (doc.format === 'html') {
			// srcdoc in a sandbox without allow-same-origin: an opaque origin, like the saved doc's frame.
			box.replaceChildren(el('<iframe class="doc-frame" sandbox="allow-scripts allow-popups allow-forms allow-modals"></iframe>'));
			$('iframe', box).srcdoc = doc.content;
		} else if (doc.format === 'svg') {
			box.innerHTML = `<div class="doc-svg"><img alt="" src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc.content)}"></div>`;
		} else {
			box.innerHTML = renderDoc(doc, '');
		}
	}, 250);
	form.addEventListener('input', () => {
		state.docEdit.dirty = true;
		preview();
	});
	form.format.addEventListener('change', syncLang);
	form.preview.addEventListener('change', preview);
	form.content.addEventListener('keydown', (e) => {
		if (e.key === 'Tab' && !e.shiftKey) {
			e.preventDefault();
			form.content.setRangeText('\t', form.content.selectionStart, form.content.selectionEnd, 'end');
			state.docEdit.dirty = true;
		}
		if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			form.requestSubmit();
		}
	});
	$('[data-act="cancel"]', form).addEventListener('click', () => {
		if (state.docEdit.dirty && !confirm('Discard your changes?')) {
			return;
		}
		state.docEdit = null;
		renderDocPane();
	});
	form.addEventListener('submit', (e) => {
		e.preventDefault();
		saveDoc(form, false).catch((err) => alert(err.message));
	});
	pane.replaceChildren(form);
	form.content.focus();
}

function editorFields(form) {
	return {
		title: form.title.value.trim(), format: form.format.value, language: form.format.value === 'code' ? form.language.value.trim() : '',
		tags: form.tags.value.split(',').map((t) => t.trim()).filter(Boolean), content: form.content.value, note: form.note.value.trim() || undefined,
	};
}

async function saveDoc(form, overwrite) {
	const body = editorFields(form);
	const ed = state.docEdit;
	let rec;
	ed.saving = true;
	try {
		if (ed.id) {
			rec = await api('PUT', P(`/docs/${encodeURIComponent(ed.id)}`), { ...body, ifVersion: overwrite ? undefined : ed.baseVersion });
		} else {
			rec = await api('POST', P('/docs'), body);
		}
	} catch (e) {
		ed.saving = false;
		if (e.status === 409 && ed.id) {
			ed.conflict = (await api('GET', P(`/docs/${encodeURIComponent(ed.id)}`)).catch(() => 'deleted'));
			showEditConflict();
			return;
		}
		throw e;
	}
	state.docEdit = null;
	state.docs.set(rec.id, (({ content: _c, ...m }) => m)(rec));
	await openDoc(rec.id);
}

// Someone else saved (or deleted) the doc while it was open in the editor: keep the user's text, offer the choices.
function showEditConflict() {
	const form = $('#doc-pane form.doc-edit');
	const ed = state.docEdit;
	if (!form || !ed || !ed.conflict) {
		return;
	}
	const box = $('.edit-conflict', form);
	if (ed.conflict === 'deleted') {
		box.innerHTML = 'This doc was deleted while you were editing. <button type="button" data-c="recreate">Save mine as a new doc</button>';
	} else {
		box.innerHTML = `${esc(byWhom(ed.conflict.updatedBy))} saved version ${ed.conflict.version} while you were editing version ${ed.baseVersion}. Your text is still here. <button type="button" data-c="overwrite">Save mine over theirs</button> <button type="button" data-c="theirs">Discard mine, load theirs</button>`;
	}
	box.hidden = false;
	box.onclick = async (e) => {
		const c = e.target.dataset.c;
		try {
			if (c === 'overwrite') {
				await saveDoc(form, true);
			} else if (c === 'theirs') {
				state.docEdit = null;
				await openDoc(ed.id);
			} else if (c === 'recreate') {
				ed.id = null;
				await saveDoc(form, false);
			}
		} catch (err) {
			alert(err.message);
		}
	};
}

// True when it is fine to leave the editor (nothing unsaved, or the user said to discard it).
function leaveEditor() {
	if (!state.docEdit || !state.docEdit.dirty) {
		return true;
	}
	if (confirm('You have unsaved changes to this doc. Discard them?')) {
		state.docEdit = null;
		return true;
	}
	return false;
}

$('#new-doc').addEventListener('click', () => {
	if (!leaveEditor()) {
		return;
	}
	state.doc = null;
	setHash();
	startEdit(null);
});
$('#doc-filter').addEventListener('input', debounce(renderDocList, 150));
window.addEventListener('beforeunload', (e) => {
	if (state.docEdit && state.docEdit.dirty) {
		e.preventDefault();
	}
});

// ---------------------------------------------------------------------------------------------------------------
// Access: signing in and out, the login mode, app tokens and browser sessions

let updateInfo = null;

// Fills the Updates dialog, and marks the button when there is something new.
async function checkUpdates(force) {
	updateInfo = await api('GET', `/api/update${force ? '?force=1' : ''}`);
	const u = updateInfo;
	$('#open-updates').textContent = u.available ? 'Update available' : 'Updates';
	$('#updates-summary').textContent = u.available ? `Version ${u.latest} is available. This server is on ${u.current}.` : `This server is up to date (${u.current}).`;
	$('#updates-notes').hidden = !u.available;
	$('#updates-notes').textContent = u.notes;
	$('#updates-install').hidden = !u.available || !u.mode;
	const detail = $('#updates-detail');
	const failed = u.status && u.status.state === 'failed' && u.status.version === u.latest;
	detail.hidden = !(failed || (u.available && !u.mode));
	detail.textContent = failed ? `The last try failed${u.status.error ? `: ${u.status.error}` : '; see the server log'}.` : 'This server is not set up to update from the page. Rerun its install command.';
}

async function installUpdate() {
	const version = updateInfo.latest;
	if (!confirm(`Update this server to ${version}? It will restart, and open pages reconnect by themselves.`)) {
		return;
	}
	const b = $('#updates-install');
	b.disabled = true;
	try {
		const started = new Date().toISOString();
		await api('POST', '/api/update', { version });
		$('#updates-summary').textContent = `Updating to ${version}...`;
		const deadline = Date.now() + 180000;
		while (Date.now() < deadline) {
			await new Promise((r) => setTimeout(r, 3000));
			const h = await fetch(`${BASE}/api/health`).then((r) => r.json()).catch(() => null);
			if (h && h.version === version) {
				location.reload();
				return;
			}
			const now = h && (await api('GET', '/api/update').catch(() => null));
			if (now && now.status && now.status.state === 'failed' && now.status.version === version && now.status.at > started) {
				await checkUpdates(false);
				$('#updates-summary').textContent = `The update to ${version} failed. This server is still on ${now.current}.`;
				return;
			}
		}
		$('#updates-summary').textContent = 'The update has not finished. Check the server log.';
	} catch (e) {
		$('#updates-summary').textContent = `Could not update: ${e.message}`;
	} finally {
		b.disabled = false;
	}
}

async function renderSignInOut() {
	const me = await api('GET', '/api/auth/me');
	state.me = me;
	const b = $('#sign-in-out');
	b.hidden = me.mode === 'off';
	b.textContent = me.signedIn && me.kind === 'session' ? 'Sign out' : 'Sign in';
	$('#open-updates').hidden = !(me.signedIn && me.kind === 'session');
	if (!$('#open-updates').hidden) {
		checkUpdates(false).catch(() => {});
	}
	return me;
}

$('#sign-in-out').addEventListener('click', async () => {
	if (state.me && state.me.signedIn && state.me.kind === 'session') {
		await api('POST', '/api/auth/logout').catch(() => {});
		location.href = state.me.mode === 'required' ? `${BASE}/login` : location.href;
		await renderSignInOut();
	} else {
		location.href = `${BASE}/login?next=${encodeURIComponent(location.pathname)}${location.hash}`;
	}
});

function credentialRow(cells, rec, current) {
	const tr = document.createElement('tr');
	tr.className = current ? 'current' : '';
	for (const c of cells) {
		const td = document.createElement('td');
		td.textContent = c;
		tr.append(td);
	}
	const td = document.createElement('td');
	const b = el('<button type="button">Revoke</button>');
	b.addEventListener('click', async () => {
		try {
			await api('DELETE', `/api/auth/tokens/${encodeURIComponent(rec.id)}`);
			if (current) {
				location.href = `${BASE}/login`;
				return;
			}
			await openAccess();
		} catch (e) {
			alert(e.message);
		}
	});
	td.append(b);
	tr.append(td);
	return tr;
}

function headRow(names) {
	return el(`<tr>${names.map((n) => `<th>${esc(n)}</th>`).join('')}<th></th></tr>`);
}

async function openAccess() {
	const me = await renderSignInOut();
	const signedIn = me.signedIn && me.kind === 'session';
	$('#access-signed-out').hidden = signedIn;
	$('#access-body').hidden = !signedIn;
	$('#install-cmd').textContent = `curl -fsSL ${location.origin}${BASE}/install | sh`;
	$('#password-cmd').textContent = me.setPassword;
	const f = $('#access-form');
	f.mode.value = me.mode;
	f.mode.disabled = me.pinned;
	$('#access-mode-note').textContent = me.pinned ? 'Pinned by PB_AUTH in the server\'s environment.' : me.passwordSet ? '' : 'Set a password before requiring logins.';
	if (signedIn) {
		const c = await api('GET', '/api/auth/tokens');
		const when = (iso) => (iso ? ago(iso) : 'never');
		$('#tokens-table').replaceChildren(headRow(['Name', 'Machine', 'Project', 'Last used', 'From', 'Made']),
			...c.tokens.map((t) => credentialRow([t.name, t.machine, t.project, when(t.lastUsed), t.lastIp, `${when(t.created)}${t.via === 'page' ? ' (on the page)' : ''}`], t, false)));
		if (!c.tokens.length) {
			$('#tokens-table').append(el('<tr><td colspan="7" class="none">No apps signed in yet.</td></tr>'));
		}
		$('#sessions-table').replaceChildren(headRow(['Browser', 'Last used', 'From', 'Signed in']),
			...c.sessions.map((s) => credentialRow([`${s.current ? 'this browser: ' : ''}${(s.agent || '').replace(/^Mozilla\/5\.0 /, '').slice(0, 70)}`, when(s.lastUsed), s.lastIp, when(s.created)], s, s.current)));
	}
	$('#new-token').hidden = true;
	if (!$('#access').open) {
		$('#access').showModal();
	}
}

$('#open-access').addEventListener('click', () => openAccess().catch((e) => alert(e.message)));
$('#access-form').mode.addEventListener('change', async (e) => {
	const m = e.target.value;
	if (m === 'off' && !confirm('Turn logins off? Anyone who can reach the board could then read and change everything.')) {
		e.target.value = state.me.mode;
		return;
	}
	try {
		await api('PATCH', '/api/auth/settings', { mode: m });
		await openAccess();
	} catch (err) {
		alert(err.message);
		e.target.value = state.me.mode;
	}
});
$('#make-token').addEventListener('click', async () => {
	try {
		const t = await api('POST', '/api/auth/tokens', { name: $('#token-name').value.trim() || undefined });
		await openAccess();
		const box = $('#new-token');
		box.replaceChildren(el('<div>Copy it now; it is not shown again. Use it as <code>PB_TOKEN</code> for pb, or the header <code>Authorization: Bearer &lt;token&gt;</code>.</div>'),
			el(`<code>${esc(t.token)}</code>`));
		box.hidden = false;
		$('#token-name').value = '';
	} catch (e) {
		alert(e.message);
	}
});

async function openRules() {
	const r = await api('GET', '/api/rules');
	const list = $('#rules-list');
	list.replaceChildren(...r.rules.map((x) => ruleBox(x.text)));
	$('#rules').showModal();
}

function ruleBox(text) {
	const ta = el('<textarea rows="3"></textarea>');
	ta.value = text;
	return ta;
}

$('#open-updates').addEventListener('click', () => {
	$('#updates').showModal();
	checkUpdates(true).catch((e) => {
		$('#updates-summary').textContent = e.message;
	});
});
$('#updates-check').addEventListener('click', () => checkUpdates(true).catch((e) => {
	$('#updates-summary').textContent = e.message;
}));
$('#updates-install').addEventListener('click', installUpdate);
$('#open-rules').addEventListener('click', () => openRules().catch((e) => alert(e.message)));
$('#add-rule').addEventListener('click', () => {
	const ta = ruleBox('');
	$('#rules-list').append(ta);
	ta.focus();
});
$('#rules-form').addEventListener('submit', (e) => {
	if (e.submitter && e.submitter.value === 'save') {
		api('PUT', '/api/rules', { rules: $$('#rules-list textarea').map((t) => t.value) }).catch((err) => alert(err.message));
	}
});
$('#settings-form').addEventListener('submit', (e) => {
	if (e.submitter && e.submitter.value === 'save') {
		saveSettings().catch((err) => alert(err.message));
	}
});
$('#copy-onboard').addEventListener('click', (e) => copyText($('#onboard-url').textContent, e.currentTarget));

// navigator.clipboard needs a secure context, which a plain-http LAN address is not: fall back to execCommand.
function copyText(text, button) {
	const done = () => {
		if (button) {
			const old = button.textContent;
			button.textContent = 'Copied';
			setTimeout(() => (button.textContent = old), 1200);
		}
	};
	if (navigator.clipboard && window.isSecureContext) {
		navigator.clipboard.writeText(text).then(done, () => legacyCopy(text) && done());
		return;
	}
	if (legacyCopy(text)) {
		done();
	} else {
		prompt('Copy this:', text);
	}
}

function legacyCopy(text) {
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.style.position = 'fixed';
	ta.style.opacity = '0';
	document.body.append(ta);
	ta.select();
	let ok = false;
	try {
		ok = document.execCommand('copy');
	} catch {
		ok = false;
	}
	ta.remove();
	return ok;
}
$('#add-project-form').addEventListener('submit', async (e) => {
	if (!e.submitter || e.submitter.value !== 'add') {
		return;
	}
	const f = e.target;
	try {
		await api('POST', '/api/projects', { slug: f.slug.value.trim(), name: f.name.value.trim(), path: f.path.value.trim() });
		await loadProjects();
		await selectProject(f.slug.value.trim());
		f.reset();
	} catch (err) {
		alert(err.message);
	}
});
$('#add-task').addEventListener('click', () => $('#add-task-dialog').showModal());
$('#add-task-form').addEventListener('submit', async (e) => {
	if (!e.submitter || e.submitter.value !== 'add') {
		return;
	}
	const f = e.target;
	try {
		await api('POST', P('/tasks'), { title: f.title.value.trim(), state: f.state.value.trim() || 'open', body: f.body.value, source: 'added on the board' });
		f.reset();
	} catch (err) {
		alert(err.message);
	}
});
$('#message-send').addEventListener('click', async () => {
	const ta = $('#message-text');
	if (!ta.value.trim()) {
		return;
	}
	try {
		await api('POST', P('/message'), { text: ta.value.trim() });
		ta.value = '';
	} catch (err) {
		alert(err.message);
	}
});
$('#drawer-close').addEventListener('click', closeDrawer);
document.addEventListener('keydown', (e) => {
	if (e.key === 'Escape') {
		closeDrawer();
		closeLightbox();
	}
});
$('#task-filter').addEventListener('input', debounce(renderTasks, 150));
$('#done-filter').addEventListener('input', debounce(renderHandoffs, 150));
$('.column[data-status="done"] .more').addEventListener('click', () => {
	state.showAllDone = true;
	renderTasks();
});
// Emptied rather than only hidden, so a video in it stops playing.
function closeLightbox() {
	const lb = $('#lightbox');
	lb.hidden = true;
	lb.replaceChildren();
}

// One video (Enlarge) or all of a card's videos (Compare), large, each with its own controls, in a grid of up to two
// columns (one for very wide ones); "Play all from start" restarts them together so a before and an after can be
// watched in step.
function openVideos(list) {
	// Very wide recordings (a strip of a page) read better stacked full width than side by side.
	const wide = list.some((v) => v.aspect > 2.5);
	const cols = wide ? 1 : Math.min(2, list.length);
	const rows = Math.ceil(list.length / cols);
	const grid = el(`<div class="lb-videos" style="--cols: ${cols}; --rows: ${rows}"></div>`);
	for (const v of list) {
		const f = el(`<figure><video src="${esc(v.src)}" controls playsinline preload="auto"></video>${v.caption ? `<figcaption>${esc(v.caption)}</figcaption>` : ''}</figure>`);
		$('video', f).currentTime = v.time || 0;
		grid.append(f);
	}
	const bar = el(`<div class="lb-bar">${list.length > 1 ? '<button type="button" class="primary lb-play">Play all from start</button>' : ''}<button type="button" class="lb-close">Close (Esc)</button></div>`);
	const lb = $('#lightbox');
	lb.replaceChildren(grid, bar);
	lb.hidden = false;
	const vids = $$('video', grid);
	if (list.length === 1) {
		vids[0].play().catch(() => {});
	}
	const play = $('.lb-play', bar);
	if (play) {
		play.addEventListener('click', () => {
			for (const v of vids) {
				v.currentTime = 0;
				v.play().catch(() => {});
			}
		});
	}
	$('.lb-close', bar).addEventListener('click', closeLightbox);
}

document.addEventListener('click', (e) => {
	const img = e.target.closest('.media img');
	if (img) {
		const lb = $('#lightbox');
		lb.replaceChildren(el(`<img src="${esc(img.src)}" alt="">`));
		lb.hidden = false;
		return;
	}
	const button = e.target.closest('.media .enlarge, .media .compare');
	if (button) {
		const figs = button.classList.contains('enlarge') ? [button.closest('figure')] : $$('figure.vid', button.closest('.media'));
		const list = figs.map((f) => {
			const v = $('video', f);
			v.pause();
			return { src: v.src, caption: f.dataset.caption, time: figs.length === 1 ? v.currentTime : 0, aspect: v.videoHeight ? v.videoWidth / v.videoHeight : 0 };
		});
		openVideos(list);
	}
});
$('#lightbox').addEventListener('click', (e) => {
	if (e.target === e.currentTarget || e.target.tagName === 'IMG') {
		closeLightbox();
	}
});
window.addEventListener('hashchange', () => {
	const r = routeFromHash();
	if (r.slug && r.slug !== state.slug && state.projects.some((p) => p.slug === r.slug)) {
		selectProject(r.slug);
	}
	if (r.tab && r.tab !== state.tab && TABS.includes(r.tab)) {
		state.tab = r.tab;
		renderTabs();
	}
	if (r.tab === 'docs' && r.docId && (!state.doc || state.doc.id !== r.docId)) {
		openDoc(r.docId);
	}
});
setInterval(() => scheduleRender('handoffs'), 60000); // keep "x min ago" fresh
$('#resync').addEventListener('click', async (e) => {
	const b = e.currentTarget;
	b.classList.add('spin');
	try {
		await resync();
		if (!state.es) {
			connectEvents(true);
		}
	} finally {
		b.classList.remove('spin');
	}
});
$('#notify-sessions').addEventListener('click', async () => {
	const r = await api('POST', P('/notify'));
	$('#notify-status').textContent = `Told ${r.woken} session${r.woken === 1 ? '' : 's'}.`;
});

init().catch((e) => {
	$('#empty').hidden = false;
	$('#empty').textContent = `Could not load: ${e.message}`;
});
