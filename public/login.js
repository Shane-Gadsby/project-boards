'use strict';
// /login (sign in, then back to ?next=) and /login/device (sign in if needed, then approve an app's code).

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(location.search);
const isDevice = location.pathname === '/login/device';

async function api(method, path, body) {
	const res = await fetch(path, {
		method,
		headers: { 'Content-Type': 'application/json', 'X-PB-Actor': 'user' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		throw new Error(data.error || `${res.status}`);
	}
	return data;
}

function show(id) {
	for (const s of ['#state-message', '#password-form', '#code-form', '#approve']) {
		$(s).hidden = s !== id;
	}
}

function message(text) {
	$('#message-text').textContent = text;
	show('#state-message');
}

function fail(el, e) {
	el.textContent = e.message;
	el.hidden = false;
}

// Only a path on this site: never send someone off to another site after signing in.
function nextUrl() {
	const n = params.get('next') || '/';
	return (n.startsWith('/') && !n.startsWith('//') ? n : '/') + location.hash;
}

async function afterSignIn() {
	if (!isDevice) {
		location.replace(nextUrl());
		return;
	}
	const code = params.get('code');
	if (code) {
		await showApproval(code);
	} else {
		show('#code-form');
	}
}

async function showApproval(code) {
	let d;
	try {
		d = await api('GET', `/api/auth/device/${encodeURIComponent(code)}`);
	} catch (e) {
		show('#code-form');
		fail($('#code-error'), e);
		return;
	}
	if (d.status !== 'pending') {
		message(`This sign-in was already ${d.status}.`);
		return;
	}
	$('#approve-client').textContent = d.client || 'An app';
	$('#approve-code').textContent = d.user_code;
	const rows = [['Machine', d.machine], ['Project', d.project], ['Asked from', d.ip], ['Started', new Date(d.created).toLocaleString()]].filter(([, v]) => v);
	$('#approve-details').replaceChildren(...rows.flatMap(([k, v]) => {
		const dt = document.createElement('dt');
		dt.textContent = k;
		const dd = document.createElement('dd');
		dd.textContent = v;
		return [dt, dd];
	}));
	show('#approve');
	const decide = async (verb) => {
		try {
			const r = await api('POST', `/api/auth/device/${encodeURIComponent(d.user_code)}/${verb}`);
			message(r.status === 'approved' ? `Done: ${d.client || 'the app'}${d.machine ? ` on ${d.machine}` : ''} is signed in. You can close this tab.` : 'Denied. The app was not signed in.');
		} catch (e) {
			fail($('#approve-error'), e);
		}
	};
	$('#allow').onclick = () => decide('approve');
	$('#deny').onclick = () => decide('deny');
}

$('#password-form').addEventListener('submit', async (e) => {
	e.preventDefault();
	try {
		await api('POST', '/api/auth/login', { password: e.target.password.value });
		await afterSignIn();
	} catch (err) {
		fail($('#password-error'), err);
		e.target.password.select();
	}
});

$('#code-form').addEventListener('submit', (e) => {
	e.preventDefault();
	$('#code-error').hidden = true;
	showApproval(e.target.code.value.trim());
});

(async () => {
	let me;
	try {
		me = await api('GET', '/api/auth/me');
	} catch (e) {
		message(`Could not reach the board: ${e.message}`);
		return;
	}
	if (me.mode === 'off') {
		message('Logins are turned off on this board, so there is nothing to sign in to.');
		return;
	}
	if (!me.passwordSet) {
		message(`No password has been set yet. Where the board's folder is reachable, run:  ${me.setPassword}`);
		return;
	}
	if (me.signedIn && me.kind === 'session') {
		await afterSignIn();
		return;
	}
	show('#password-form');
	$('#password-form').password.focus();
})();
