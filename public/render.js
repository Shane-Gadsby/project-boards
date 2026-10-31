'use strict';

// The sub-path this page is on, '' at the root (set by the server).
const BASE = window.PB_BASE || '';

// Records keep /media/... whatever address they were made on.
function mediaUrl(url) {
	return String(url).startsWith('/media/') ? BASE + url : url;
}
// Shared by the board (app.js) and the full-page doc view (doc.js): a small, safe markdown renderer, and the body of a
// doc in each format. Everything is escaped first; HTML and SVG docs never enter this page's DOM: they load from the
// raw URL into a sandboxed frame (and the server adds a CSP sandbox), so their scripts run in an opaque origin.

function escHtml(s) {
	return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Links and images may point at http(s), mailto, this site (/...) or an anchor; nothing else (no javascript:).
const SAFE_URL = /^(https?:\/\/|mailto:|\/(?!\/)|#)/i;

function mdInline(s) {
	const code = [];
	let out = escHtml(s).replace(/`([^`]+)`/g, (_, c) => {
		code.push(c);
		return `\u0000${code.length - 1}\u0000`;
	});
	out = out
		.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt, url) => (SAFE_URL.test(url) ? `<img src="${mediaUrl(url)}" alt="${alt}" loading="lazy">` : m))
		.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, url) => (SAFE_URL.test(url) ? `<a href="${mediaUrl(url)}" target="_blank" rel="noopener">${text}</a>` : m))
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
		.replace(/(^|[^_\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>')
		.replace(/~~([^~]+)~~/g, '<del>$1</del>');
	return out.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${code[i]}</code>`);
}

function md(src) {
	const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
	const out = [];
	let fence = null;
	let fenceOpen = '';
	let code = [];
	let list = null;
	let table = null;
	let quote = [];
	let para = [];
	const closePara = () => {
		if (para.length) {
			out.push(`<p>${para.join(' ')}</p>`);
			para = [];
		}
	};
	const closeList = () => {
		if (list) {
			out.push(`</${list}>`);
			list = null;
		}
	};
	const closeTable = () => {
		if (table) {
			out.push('</tbody></table>');
			table = null;
		}
	};
	const closeQuote = () => {
		if (quote.length) {
			out.push(`<blockquote>${md(quote.join('\n'))}</blockquote>`);
			quote = [];
		}
	};
	const closeAll = () => {
		closePara();
		closeList();
		closeTable();
		closeQuote();
	};
	const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const f = /^\s*(```|~~~)\s*([\w+#.-]*)/.exec(line);
		if (fence) {
			if (f && f[1] === fence) {
				out.push(`${fenceOpen}${code.join('\n')}</code></pre>`);
				fence = null;
				code = [];
			} else {
				code.push(escHtml(line));
			}
			continue;
		}
		if (f) {
			closeAll();
			fence = f[1];
			// The block goes out in one piece at the closing fence, so the line joins add no stray newlines inside it.
			fenceOpen = `<pre${f[2] ? ` data-lang="${escHtml(f[2])}"` : ''}><code>`;
			continue;
		}
		if (/^\s*>/.test(line)) {
			closePara();
			closeList();
			closeTable();
			quote.push(line.replace(/^\s*>\s?/, ''));
			continue;
		}
		closeQuote();
		const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
		if (h) {
			closeAll();
			const n = Math.min(4, h[1].length);
			out.push(`<h${n}>${mdInline(h[2])}</h${n}>`);
			continue;
		}
		if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
			closeAll();
			out.push('<hr>');
			continue;
		}
		if (/^\s*\|.*\|\s*$/.test(line)) {
			closePara();
			closeList();
			if (!table) {
				const header = /^\s*\|[\s|:-]+\|\s*$/.test(lines[i + 1] || '');
				out.push('<table>');
				if (header) {
					out.push(`<thead><tr>${cells(line).map((c) => `<th>${mdInline(c)}</th>`).join('')}</tr></thead>`);
					i++;
				}
				out.push('<tbody>');
				table = true;
				if (header) {
					continue;
				}
			}
			out.push(`<tr>${cells(line).map((c) => `<td>${mdInline(c)}</td>`).join('')}</tr>`);
			continue;
		}
		closeTable();
		const li = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
		if (li) {
			closePara();
			const kind = /\d/.test(li[1]) ? 'ol' : 'ul';
			if (list !== kind) {
				closeList();
				out.push(`<${kind}>`);
				list = kind;
			}
			const task = /^\[([ xX])\]\s+(.*)$/.exec(li[2]);
			out.push(task ? `<li class="task-item"><input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> ${mdInline(task[2])}</li>` : `<li>${mdInline(li[2])}</li>`);
			continue;
		}
		if (!line.trim()) {
			closeAll();
			continue;
		}
		if (list && /^\s{2,}\S/.test(line)) {
			out[out.length - 1] = out[out.length - 1].replace(/<\/li>$/, ` ${mdInline(line.trim())}</li>`);
			continue;
		}
		closeList();
		para.push(mdInline(line));
	}
	if (fence) {
		out.push(`${fenceOpen}${code.join('\n')}</code></pre>`);
	}
	closeAll();
	return out.join('\n');
}

// RFC 4180-ish: quoted fields, doubled quotes, commas and newlines inside quotes.
function parseCsv(text) {
	const rows = [];
	let row = [];
	let field = '';
	let quoted = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quoted) {
			if (ch === '"' && text[i + 1] === '"') {
				field += '"';
				i++;
			} else if (ch === '"') {
				quoted = false;
			} else {
				field += ch;
			}
		} else if (ch === '"') {
			quoted = true;
		} else if (ch === ',') {
			row.push(field);
			field = '';
		} else if (ch === '\n' || ch === '\r') {
			if (ch === '\r' && text[i + 1] === '\n') {
				i++;
			}
			row.push(field);
			rows.push(row);
			row = [];
			field = '';
		} else {
			field += ch;
		}
	}
	if (field || row.length) {
		row.push(field);
		rows.push(row);
	}
	return rows;
}

// The body of a doc as HTML. rawUrl: where the doc's raw content is served (for the HTML and SVG frames).
function renderDoc(doc, rawUrl) {
	const content = String(doc.content || '');
	switch (doc.format) {
		case 'markdown':
			return `<div class="md doc-md">${md(content)}</div>`;
		case 'html':
			return `<iframe class="doc-frame" sandbox="allow-scripts allow-popups allow-forms allow-modals" referrerpolicy="no-referrer" src="${escHtml(rawUrl)}" title="${escHtml(doc.title)}"></iframe>`;
		case 'svg':
			return `<div class="doc-svg"><img src="${escHtml(rawUrl)}" alt="${escHtml(doc.title)}"></div>`;
		case 'json': {
			let pretty = content;
			try {
				pretty = JSON.stringify(JSON.parse(content), null, 2);
			} catch {
				// show it as it is
			}
			return `<pre class="doc-code" data-lang="json"><code>${escHtml(pretty)}</code></pre>`;
		}
		case 'csv': {
			const rows = parseCsv(content);
			if (!rows.length) {
				return '<p class="hint">Empty.</p>';
			}
			const [head, ...body] = rows;
			return `<div class="doc-table"><table><thead><tr>${head.map((c) => `<th>${escHtml(c)}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${escHtml(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
		}
		case 'code':
			return `<pre class="doc-code"${doc.language ? ` data-lang="${escHtml(doc.language)}"` : ''}><code>${escHtml(content)}</code></pre>`;
		default:
			return `<pre class="doc-code doc-text"><code>${escHtml(content)}</code></pre>`;
	}
}
