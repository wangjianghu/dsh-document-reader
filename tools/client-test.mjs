// Client regression suite — component-level tests in jsdom.
// Run from the vendor build dir:   cd /tmp/dsh-vendor-build && node <plugin>/tools/client-test.mjs
// NOTE: react-dom must be required AFTER jsdom globals are installed (see smoke-test.mjs).
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(process.cwd() + '/'));
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.AbortController = dom.window.AbortController;
global.DOMParser = dom.window.DOMParser;
global.NodeFilter = dom.window.NodeFilter;
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
// jsdom lacks scrollIntoView; stub it for search-focus code paths
dom.window.Element.prototype.scrollIntoView = dom.window.Element.prototype.scrollIntoView || (() => {});
if (typeof global.URL.createObjectURL !== 'function') global.URL = dom.window.URL;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = dom.window.TextDecoder;

// react-dom AFTER jsdom globals (load-order trap, see smoke-test.mjs)
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react-dom/test-utils');

process.on('unhandledRejection', (e) => { console.log('UNHANDLED:', (e?.stack || String(e)).split('\n').slice(0, 3).join(' | ')); });
// ---------- tiny runner ----------
const results = [];
const check = (name, cond, detail = '') => {
	results.push({ name, ok: !!cond });
	console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${cond ? '' : ` — ${detail}`}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mock file system ----------
const encoder = new TextEncoder();
const files = new Map(); // path -> { status, body }  (body: string | ArrayBuffer)
const routeHandlers = new Map(); // suffix -> async (url, opts) => Response-like | null
const respond = (status, body, extra = {}) => ({ status, ok: status < 400, arrayBuffer: async () => (body instanceof ArrayBuffer ? body : encoder.encode(String(body)).buffer), text: async () => String(body ?? ''), json: async () => { try { return JSON.parse(String(body ?? '{}')); } catch { return {}; } }, ...extra });
global.fetch = async (url, opts = {}) => {
	url = String(url);
	for (const [suffix, handler] of routeHandlers) {
		if (url.includes(suffix)) {
			const out = await handler(url, opts);
			if (out) return out;
		}
	}
	if (url.includes('/file/')) {
		const path = decodeURIComponent(url.slice(url.indexOf('/file/') + '/file/'.length));
		const entry = files.get(path);
		if (!entry) return respond(404, JSON.stringify({ error: 'not found' }));
		if (opts.method === 'HEAD') return respond(entry.status ?? 200, '');
		return respond(entry.status ?? 200, entry.body);
	}
	return respond(200, '{}');
};
dom.window.fetch = global.fetch;

// ---------- plugin setup ----------
let capturedFactory;
global.window.__ModuleLoader__ = { load: (m) => { capturedFactory = m.factory; } };
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
// `navigator` is shadowed explicitly: Node ≥21 exposes a non-writable global
// navigator without the Clipboard API, so the bundle's bare `navigator` must
// be pinned to jsdom's (where the test can mock `clipboard`).
new Function('window', 'document', 'localStorage', 'requestAnimationFrame', 'navigator', source)(
	global.window, global.document, global.localStorage, global.requestAnimationFrame, dom.window.navigator);

const fakeVendor = {
	MarkdownIt: class MarkdownIt {
		constructor() { this.renderer = { rules: {} }; }
		render(text, env) {
			if (env?.outline) {
				let off = 0;
				for (const line of text.split('\n')) {
					const m = /^(#{1,6})\s+(.*)$/.exec(line);
					if (m) env.outline.push({ level: m[1].length, text: m[2].trim(), id: `ln-${off}` });
					off += line.length + 1;
				}
			}
			return text.split('\n').map((line) => (line.startsWith('# ')
				? `<h1>${line.slice(2)}</h1>` : `<p>${line}</p>`)).join('');
		}
	},
	JSZip: require('jszip'),
	loadDocx: () => ({ renderAsync: async () => {} }),
};
const componentRefs = {};
const registeredLocales = {};
const registeredShortcuts = [];
const registeredSources = [];
const fakeInputTriggers = { registerSource: (s) => { registeredSources.push(s); return () => {}; } };
const ctx = {
	effect: (fn) => { try { fn(); } catch {} return () => {}; },
	get: (name) => (name === 'inputTriggers' ? fakeInputTriggers : undefined),
	shortcuts: { register: (c) => { registeredShortcuts.push(c); return () => {}; } },
	logger: { warn: () => {} },
	locale: { register: (ns, locale, dict) => { registeredLocales[locale] = dict; return () => {}; }, bind: () => (key) => key },
	slots: {
		inject: (name, cb) => { try { cb(); } catch (e) { console.error('inject failed', name, e.message); } },
		register: (options, Component) => { componentRefs[options.name] = Component; return () => {}; },
	},
	layout: { selectPanel: () => {} },
};
const requireStub = (spec) => { if (spec === 'react') return React; throw new Error('unexpected require: ' + spec); };
requireStub.async = async () => fakeVendor;
capturedFactory(requireStub).apply(ctx);

const Panel = componentRefs['main'];
if (!Panel) { console.error('main panel not registered'); process.exit(1); }
global.IS_REACT_ACT_ENVIRONMENT = true;
const root = createRoot(document.getElementById('host'));
await act(async () => { root.render(React.createElement(Panel)); });
const rootEl = document.getElementById('host');

const typeIntoPath = async (value) => {
	const input = rootEl.querySelector('.dr-path');
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
	await act(async () => {
		setter.call(input, value);
		input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	});
	await act(async () => {
		input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	});
	await act(async () => { await sleep(60); });
};
const openFile = async (path, body, extra = {}) => {
	files.set(path, { status: 200, body, ...extra });
	await typeIntoPath(path);
	await act(async () => { await sleep(40); });
};
const btnByTitle = (title) => [...rootEl.querySelectorAll('.dr-btn')].find((b) => b.getAttribute('title') === title || b.getAttribute('aria-label') === title);
const searchInput = () => rootEl.querySelector('.dr-viewbar input[type="search"]');
const setSearch = async (value) => {
	const el = searchInput();
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
	await act(async () => {
		setter.call(el, value);
		el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	});
};
const pressEnter = async (shift = false) => {
	await act(async () => {
		searchInput().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: shift, bubbles: true }));
	});
	await act(async () => { await sleep(20); });
};

// ---------- 1. markdown basics ----------
files.set('/tmp/r1.md', { status: 200, body: '# Title One\n\nhello world hello' });
await typeIntoPath('/tmp/r1.md');
await act(async () => { await sleep(80); });
const art1 = rootEl.querySelector('.dr-md');
check('md: renders heading', !!art1?.querySelector('h1'));
check('md: title bar shows filename', rootEl.querySelector('.dr-rename-name')?.textContent === 'r1.md');

// ---------- 2. scroll position save + restore ----------
{
	const scroll = rootEl.querySelector('.dr-scroll');
	await act(async () => {
		scroll.scrollTop = 500;
		scroll.dispatchEvent(new dom.window.Event('scroll', { bubbles: true }));
	});
	await act(async () => { await sleep(380); });
	const saved = JSON.parse(localStorage.getItem('dsh-doc-reader:pos:/tmp/r1.md') ?? 'null');
	check('scroll: persisted after 300ms debounce', saved && saved.scrollTop === 500 && saved.kind === 'markdown', JSON.stringify(saved));
	await openFile('/tmp/r1.md', '# Title One\n\nhello world hello');
	await act(async () => { await sleep(40); });
	check('scroll: restored on reopen', rootEl.querySelector('.dr-scroll')?.scrollTop === 500, `got ${rootEl.querySelector('.dr-scroll')?.scrollTop}`);
}

// ---------- 3. font size persistence ----------
{
	const plus = btnByTitle('panel.fontBigger');
	await act(async () => { plus.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(20); });
	const saved = JSON.parse(localStorage.getItem('dsh-doc-reader:pos:/tmp/r1.md') ?? 'null');
	check('font: persisted with position', saved?.fontSize === (saved?.fontSize ?? 0) && typeof saved?.fontSize === 'number', JSON.stringify(saved));
}

// ---------- 4. DOM search: highlight + navigate ----------
{
	await setSearch('hello');
	await pressEnter();
	const marks = rootEl.querySelectorAll('mark.dr-mark');
	check('search: highlights matches', marks.length === 2, `got ${marks.length}`);
	check('search: count badge shows n/m', rootEl.querySelector('.dr-count')?.textContent === '1/2', rootEl.querySelector('.dr-count')?.textContent);
	const next = btnByTitle('panel.searchNext');
	await act(async () => { next.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	check('search: navigate moves active', rootEl.querySelectorAll('mark.dr-mark.active').length === 1 && marks[1].classList.contains('active'));
}

// ---------- 5. text view chunking (>512KB) ----------
{
	const big = ('line of text content\n').repeat(30000); // 21B x 30000 = 630KB > 512KB
	await openFile('/tmp/big.log', big);
	await act(async () => { await sleep(60); });
	const chunks = rootEl.querySelectorAll('.dr-text > div');
	check('text: >512KB chunked', chunks.length > 3, `got ${chunks.length}`);
	check('text: chunk content intact', rootEl.querySelector('.dr-text')?.textContent?.length > 500000);
}

// ---------- 6. giant markdown degrades to plain ----------
{
	const huge = `# big\n${'para text\n'.repeat(600000)}`; // >4MB
	await openFile('/tmp/huge.md', huge);
	await act(async () => { await sleep(120); });
	const pre = rootEl.querySelector('.dr-text');
	const badge = [...rootEl.querySelectorAll('.dr-badge')].some((b) => b.textContent === 'panel.mdPlainMode');
	check('md: >4MB degrades to plain pre', !!pre);
	check('md: plain-mode badge shown', badge);
}

// ---------- 7. edit mode: enter, search, layout, save ----------
{
	files.set('/tmp/edit.txt', { status: 200, body: 'alpha beta\ngamma delta\n' });
	await typeIntoPath('/tmp/edit.txt');
	await act(async () => { await sleep(80); });
	const editBtn = btnByTitle('panel.editDocument');
	await act(async () => { editBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(20); });
	const area = rootEl.querySelector('.dr-editor');
	check('edit: textarea mounted', !!area);
	// layout: search input before flex spacer before exit-edit button
	const bar = [...rootEl.querySelector('.dr-viewbar').children];
	const searchIdx = bar.findIndex((el) => el.tagName === 'INPUT');
	const exitIdx = bar.findIndex((el) => el.tagName === 'BUTTON' && el.getAttribute('title') === 'panel.exitEdit');
	check('edit: exit/save pushed right', searchIdx >= 0 && exitIdx > searchIdx && bar.slice(searchIdx + 1, exitIdx).some((el) => el.tagName === 'SPAN' && !!el.style.flex && !el.className));
	// search in editor
	await setSearch('beta');
	await pressEnter();
	check('edit-search: selection on match', area.selectionStart === 6 && area.selectionEnd === 10, `sel ${area.selectionStart}-${area.selectionEnd}`);
	// modify + save
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
	await act(async () => {
		setter.call(area, 'alpha beta CHANGED');
		area.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	});
	await act(async () => { await sleep(20); });
	let savedBody = null;
	routeHandlers.set('/save', async (url, opts) => {
		if (opts.method !== 'POST') return null;
		savedBody = JSON.parse(opts.body);
		return respond(200, JSON.stringify({ ok: true }));
	});
	const saveBtn = btnByTitle('panel.save');
	check('edit: save enabled when dirty', saveBtn && !saveBtn.disabled);
	await act(async () => { saveBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(40); });
	check('edit: save posts content', savedBody?.content === 'alpha beta CHANGED' && savedBody?.baseContent === 'alpha beta\ngamma delta\n', JSON.stringify(savedBody && { base: savedBody.baseContent, content: savedBody.content }));
	routeHandlers.delete('/save');
}

// ---------- 7b. edit mode shows live outline from the draft ----------
{
	files.set('/tmp/outline.md', { status: 200, body: '# Alpha\n\nbody\n## Beta\nmore' });
	await typeIntoPath('/tmp/outline.md');
	await act(async () => { await sleep(80); });
	const editBtn = btnByTitle('panel.editDocument');
	await act(async () => { editBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(20); });
	// through the debounce window the preview outline must stay mounted (no flicker)
	const earlyAside = rootEl.querySelector('aside');
	check('edit-outline: sidebar stays through debounce', !!earlyAside
		&& [...(earlyAside?.querySelectorAll('button') ?? [])].some((b) => b.getAttribute('title') === 'Alpha'));
	await act(async () => { await sleep(350); }); // debounce 300ms
	const aside = rootEl.querySelector('aside');
	const betaBtn = [...(aside?.querySelectorAll('button') ?? [])].find((b) => b.getAttribute('title') === 'Beta');
	check('edit-outline: items appear while editing', !!betaBtn);
	if (betaBtn) {
		await act(async () => { betaBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
		const area = rootEl.querySelector('.dr-editor');
		check('edit-outline: jump puts caret at heading start', area.selectionStart === 14, `sel=${area.selectionStart}`);
	}
	// exit edit to restore preview outline path
	const exitBtn = btnByTitle('panel.exitEdit');
	await act(async () => { exitBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(30); });
}

// ---------- 8. rename: escape then enter still commits ----------
{
	files.set('/tmp/rename.md', { status: 200, body: 'x' });
	await typeIntoPath('/tmp/rename.md');
	await act(async () => { await sleep(60); });
	const titleBtn = rootEl.querySelector('.dr-rename-btn');
	await act(async () => { titleBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(10); });
	let input = rootEl.querySelector('.dr-rename-input');
	await act(async () => {
		input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
	});
	await act(async () => { await sleep(10); });
	const titleBtn2 = rootEl.querySelector('.dr-rename-btn'); // re-query: old node was detached
	await act(async () => { titleBtn2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(10); });
	input = rootEl.querySelector('.dr-rename-input');
	check('rename: input reopens after escape', !!input);
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
	await act(async () => {
		setter.call(input, 'renamed-target');
		input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	});
	let renameBody = null;
	routeHandlers.set('/rename', async (url, opts) => {
		if (opts.method !== 'POST') return null;
		renameBody = JSON.parse(opts.body);
		return respond(200, JSON.stringify({ ok: true, path: '/tmp/renamed-target.md' }));
	});
	await act(async () => {
		input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	});
	await act(async () => { await sleep(40); });
	check('rename: commits after prior escape (cancelledRef reset)', renameBody?.name === 'renamed-target', JSON.stringify(renameBody));
	routeHandlers.delete('/rename');
	files.set('/tmp/renamed-target.md', { status: 200, body: 'x' });
}

// ---------- 9. epub pipeline ----------
{
	const JSZip = require('jszip');
	const zip = new JSZip();
	zip.file('mimetype', 'application/epub+zip');
	zip.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
	zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><manifest>'
		+ '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>'
		+ '<item id="img" href="pic.png" media-type="image/png"/></manifest>'
		+ '<spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
	zip.file('OEBPS/ch1.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><h1>第一章</h1><p>epub content</p><img src="pic.png"/><img data-src="pic.png"/><script>alert(1)</script><p onclick="evil()">x</p></body></html>');
	zip.file('OEBPS/ch2.xhtml', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>第二章 body</p></body></html>');
	zip.file('OEBPS/pic.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex'));
	await openFile('/tmp/book.epub', await zip.generateAsync({ type: 'arraybuffer' }));
	await act(async () => { await sleep(150); });
	const eart = rootEl.querySelector('.dr-md');
	check('epub: chapter renders', !!eart?.textContent?.includes('第一章'));
	check('epub: script stripped', !eart?.querySelector('script'));
	check('epub: onclick stripped', !eart?.querySelector('[onclick]'));
	console.log('EPUBDBG img:', rootEl.querySelector('.dr-md img')?.outerHTML?.slice(0,120));
	check('epub: image -> blob url', (eart?.querySelector('img')?.getAttribute('src') || '').startsWith('blob:'));
	check('epub: data-src image normalized to blob', [...(eart?.querySelectorAll('img') ?? [])].every((im) => (im.getAttribute('src') || '').startsWith('blob:')));
	const next = btnByTitle('panel.nextPage');
	await act(async () => { next.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(150); });
	check('epub: chapter navigation', rootEl.querySelector('.dr-md')?.textContent?.includes('第二章'));
}

	// gbk-encoded epub chapter decodes via sniffing
	{
		const JSZip = require('jszip');
		const zip2 = new JSZip();
		zip2.file('mimetype', 'application/epub+zip');
		zip2.file('META-INF/container.xml', '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="b.opf"/></rootfiles></container>');
		zip2.file('b.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>');
		const gbkBody = new Uint8Array([0x3c, 0x68, 0x74, 0x6d, 0x6c, 0x3e, 0x3c, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x70, 0x3e, 0xd6, 0xd0, 0xce, 0xc4, 0xc4, 0xda, 0xc8, 0xdd, 0x3c, 0x2f, 0x70, 0x3e, 0x3c, 0x2f, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0x3c, 0x2f, 0x68, 0x74, 0x6d, 0x6c, 0x3e]); // <html><body><p>中文内容</p></body></html> in GBK
		zip2.file('c.xhtml', gbkBody);
		files.set('/tmp/gbk-book.epub', { status: 200, body: await zip2.generateAsync({ type: 'arraybuffer' }) });
		await typeIntoPath('/tmp/gbk-book.epub');
		await act(async () => { await sleep(150); });
			check('epub: gbk chapter decoded', rootEl.querySelector('.dr-md')?.textContent?.includes('中文内容'), rootEl.querySelector('.dr-md')?.textContent?.slice(0, 40));
	}

// ---------- 10. html view: sanitize + image rewrite ----------
{
	files.set('/tmp/img/pic.jpg', { status: 200, body: 'jpegbytes' });
	await openFile('/tmp/page.html', '<html><body><h2>Local page</h2><img src="img/pic.jpg"/><a href="javascript:evil()">bad</a><a href="java&#9;script:evil()">tab</a><video src="https://evil/x.mp4" poster="https://evil/p.jpg"></video><script>evil()</script></body></html>');
	await act(async () => { await sleep(80); });
	const hart = rootEl.querySelector('.dr-md');
	check('html: renders sanitized', !!hart?.querySelector('h2'));
	check('html: script removed', !hart?.querySelector('script'));
	check('html: relative image rewritten to file route', (hart?.querySelector('img')?.getAttribute('src') || '').includes('/doc-reader/'));
	const badLink = hart?.querySelector('a');
	check('html: javascript: href stripped', badLink && !badLink.getAttribute('href'));
	const links = hart?.querySelectorAll('a') ?? [];
	check('html: tab-variant javascript: stripped', [...links].every((a) => !/^\s*java/i.test(a.getAttribute('href') || '')));
	check('html: video element removed', !hart?.querySelector('video'));
}

// ---------- 11. handoff: kind filter ----------
{
	const Handoff = componentRefs['sidebar.right.tab.document.actions'];
	const mount = async (p) => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const r2 = createRoot(host);
		await act(async () => { r2.render(React.createElement(Handoff, { absolutePath: p })); });
		return host;
	};
	const good = await mount('/tmp/x.pdf');
	const bad = await mount('/tmp/x.exe');
	check('handoff: button for supported kind', !!good.querySelector('button'));
	check('handoff: hidden for unsupported kind', bad.childElementCount === 0);
}

// ---------- 14. GBK decode ----------
{
	const GBK_BYTES = new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3, 0x0A]).buffer;
	await openFile('/tmp/gbk2.log', GBK_BYTES);
	await act(async () => { await sleep(60); });
	check('gbk: decoded', rootEl.querySelector('.dr-text')?.textContent?.includes('你好'), JSON.stringify(rootEl.querySelector('.dr-text')?.textContent?.slice(0, 20)));
}


// ---------- 12. open race: slow first probe loses ----------
{
	let resolveSlow;
	files.set('/tmp/slow.md', { status: 200, body: '# slow' });
	files.set('/tmp/fast.md', { status: 200, body: '# fast' });
	const origFetch = global.fetch;
	global.fetch = async (url, opts = {}) => {
		if (String(url).includes(encodeURIComponent('/tmp/slow.md'))) {
			await new Promise((r) => { resolveSlow = r; });
			return origFetch(url, opts);
		}
		return origFetch(url, opts);
	};
	dom.window.fetch = global.fetch;
	await typeIntoPath('/tmp/slow.md'); // input chain completes; the probe stays hung
	await typeIntoPath('/tmp/fast.md');
	await act(async () => { await sleep(40); });
	resolveSlow();
	await act(async () => { await sleep(200); }); // let the late slow-chain finish so later scenes are not disturbed
	check('race: last open wins', rootEl.querySelector('.dr-rename-name')?.textContent === 'fast.md', rootEl.querySelector('.dr-rename-name')?.textContent);
	global.fetch = origFetch;
	dom.window.fetch = origFetch;
}

// ---------- 13. recent list updates + dead entry pruning ----------
{
	const before = JSON.parse(localStorage.getItem('dsh-doc-reader:recent') ?? '[]');
	check('recent: opens recorded', before.some((e) => e.path === '/tmp/fast.md'));
}

// ---------- 15. language switch ----------
{
	// version marker: distinguishes a stale cached bundle from a code bug
	check('version: panel root carries client version', rootEl.querySelector('.dr-panel')?.getAttribute('data-doc-reader-version') === '1.0.3',
		rootEl.querySelector('.dr-panel')?.getAttribute('data-doc-reader-version') ?? 'missing');
	const gear = btnByTitle('panel.settings');
	await act(async () => { gear.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	check('version: settings dialog shows client version', rootEl.querySelector('[data-doc-reader-client-version]')?.textContent === 'v1.0.3');
	const select = rootEl.querySelector('select');
	const setSelect = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
	await act(async () => {
		setSelect.call(select, 'zh-tw');
		select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	});
	const saveBtn = [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'panel.save');
	await act(async () => { saveBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(30); });
	const logo = rootEl.querySelector('.dr-logo')?.textContent ?? '';
	check('lang: panel switches to zh-tw', logo.includes('閱讀器'), logo);
	// switch back to auto (UI is in zh-tw now, so button titles are Traditional Chinese)
	const gear2 = [...rootEl.querySelectorAll('button')].find((b) => ['title', 'aria-label'].some((a) => b.getAttribute(a) === '閱讀器設定' || b.getAttribute(a) === 'panel.settings'));
	await act(async () => { gear2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	const sel2 = rootEl.querySelector('select');
	await act(async () => {
		setSelect.call(sel2, 'auto');
		sel2.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
	});
	const save2 = [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === '儲存');
	await act(async () => { save2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(30); });
	check('lang: back to follow-DSH', (rootEl.querySelector('.dr-logo')?.textContent ?? '').includes('panel.title'));
}


// ---------- 16. AI/DSH integration: active report ----------
{
	let activePosts = [];
	routeHandlers.set('/active', async (url, opts) => {
		if (opts.method === 'POST') { try { activePosts.push(JSON.parse(opts.body)); } catch { /* ignore */ } }
		return respond(200, JSON.stringify({ ok: true }));
	});
	files.set('/tmp/ai.md', { status: 200, body: '# Alpha\n\nhello world\n' });
	await typeIntoPath('/tmp/ai.md');
	await act(async () => { await sleep(80); });
	check('ai-active: opening reports the document', activePosts.some((e) => e.path === '/tmp/ai.md'));
}

// ---------- 17. AI/DSH integration: tool-view card bridges to the reader ----------
{
	const ToolView = componentRefs['tool.call.toolview'];
	check('ai-toolcard: component registered', typeof ToolView === 'function');
	await act(async () => {
		root.render(React.createElement(ToolView, { call: { name: 'doc_reader', arguments: { action: 'read', path: '/tmp/ai.md' }, result: '# Alpha\nhello world preview' } }));
	});
	let card = rootEl.querySelector('[data-doc-reader-tool]');
	check('ai-toolcard: renders for doc_reader', !!card && card.textContent.includes('read') && card.textContent.includes('hello world preview'));
	check('ai-toolcard: shows the file name', card.textContent.includes('ai.md'));
	await act(async () => {
		root.render(React.createElement(ToolView, { call: { name: 'other_tool', arguments: {}, result: 'x' } }));
	});
	check('ai-toolcard: ignores other tools', !rootEl.querySelector('[data-doc-reader-tool]'));
	await act(async () => {
		root.render(React.createElement(ToolView, { call: { name: 'doc_reader', arguments: { action: 'read', path: '/tmp/ai.md' }, result: 'x' } }));
	});
	const openBtn = rootEl.querySelector('[data-doc-reader-tool] button');
	check('ai-toolcard: open-in-reader button present', !!openBtn);
	await act(async () => { openBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { root.render(React.createElement(Panel)); }); // panel consumes the handoff
	await act(async () => { await sleep(180); });
	check('ai-toolcard: click opens the document in the reader', rootEl.querySelector('.dr-rename-name')?.textContent === 'ai.md', rootEl.querySelector('.dr-rename-name')?.textContent);
}

// ---------- 18. AI/DSH integration: SSE external change + conflict bar ----------
{
	const instances = [];
	class FakeEventSource {
		constructor(url) { this.url = String(url); this.onmessage = null; instances.push(this); }
		close() { this.closed = true; }
	}
	global.EventSource = FakeEventSource;
	files.set('/tmp/watch.md', { status: 200, body: '# Watched\n\nfirst version\n' });
	await typeIntoPath('/tmp/watch.md');
	await act(async () => { await sleep(120); });
	const live = instances.find((i) => !i.closed && i.url.includes(encodeURIComponent('/tmp/watch.md')));
	check('ai-sse: subscribes to the open document', !!live, instances.map((i) => i.url).join(' | '));
	// non-editing: change event auto-reloads
	files.set('/tmp/watch.md', { status: 200, body: '# Watched\n\nsecond version\n' });
	await act(async () => { live.onmessage({ data: JSON.stringify({ type: 'change', path: '/tmp/watch.md' }) }); });
	await act(async () => { await sleep(150); });
	check('ai-sse: external change auto-reloads', rootEl.textContent.includes('second version'), rootEl.textContent.slice(0, 80));
	// editing: change event shows the conflict bar instead
	const editBtn = btnByTitle('panel.editDocument');
	await act(async () => { editBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(50); });
	files.set('/tmp/watch.md', { status: 200, body: '# Watched\n\nthird version\n' });
	await act(async () => { live.onmessage({ data: JSON.stringify({ type: 'change', path: '/tmp/watch.md' }) }); });
	await act(async () => { await sleep(80); });
	const bar = rootEl.querySelector('.dr-external');
	check('ai-sse: editing shows conflict bar', !!bar && bar.textContent.includes('panel.externalChanged'));
	const reloadBtn = [...rootEl.querySelectorAll('.dr-external button')].find((b) => b.getAttribute('title') === undefined || b.textContent.includes('panel.reloadNow'));
	check('ai-sse: conflict bar has reload action', !!reloadBtn);
	await act(async () => { reloadBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(150); });
	check('ai-sse: reload-from-disk loads new content', rootEl.textContent.includes('third version') && !rootEl.querySelector('.dr-external'), rootEl.textContent.slice(0, 80));
	// /doc open broadcast reaches the panel
	await act(async () => { live.onmessage({ data: JSON.stringify({ type: 'open', path: '/tmp/ai.md' }) }); });
	await act(async () => { await sleep(150); });
	check('ai-sse: open broadcast switches document', rootEl.querySelector('.dr-rename-name')?.textContent === 'ai.md', rootEl.querySelector('.dr-rename-name')?.textContent);
	delete global.EventSource;
}

// ---------- 19. plugins.row.config settings row ----------
{
	let configState = { ctxInjectEnabled: true, ctxOutlineCount: 30, autoReloadEnabled: true, toolEnabled: true, commandEnabled: true };
	const configPosts = [];
	routeHandlers.set('/config', async (url, opts) => {
		if (opts.method === 'POST') {
			const patch = JSON.parse(opts.body);
			configPosts.push(patch);
			Object.assign(configState, patch);
		}
		return respond(200, JSON.stringify(configState));
	});
	const RowConfig = componentRefs['plugins.row.config'];
	check('ai-rowconfig: component registered', typeof RowConfig === 'function');
	await act(async () => { root.render(React.createElement(RowConfig)); });
	await act(async () => { await sleep(60); });
	const switches = [...rootEl.querySelectorAll('[data-doc-reader-config] [role="switch"]')];
	check('ai-rowconfig: four switches rendered', switches.length === 4, String(switches.length));
	check('ai-rowconfig: defaults on', switches.every((s) => s.getAttribute('aria-checked') === 'true'));
	await act(async () => { switches[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(80); });
	check('ai-rowconfig: toggle posts config', configPosts.some((p) => p.ctxInjectEnabled === false));
	check('ai-rowconfig: switch reflects state', rootEl.querySelectorAll('[data-doc-reader-config] [role="switch"]')[0].getAttribute('aria-checked') === 'false');
	const numberInput = rootEl.querySelector('[data-doc-reader-config] input[type="number"]');
	check('ai-rowconfig: outline count input', !!numberInput && numberInput.value === '30');
	// restore the panel for a clean tree
	await act(async () => { root.render(React.createElement(Panel)); });
	await act(async () => { await sleep(60); });
}


// ---------- 20. recent row hover: Finder icon + instant tooltip ----------
{
	localStorage.setItem('dsh-doc-reader:recent', JSON.stringify([
		{ path: '/tmp/tooltip.md', kind: 'markdown', at: Date.now() },
	]));
	files.set('/tmp/tooltip.md', { status: 200, body: '# Tip' });
	await act(async () => { root.render(React.createElement(Panel)); });
	await act(async () => { await sleep(120); });
	const revealBtn = rootEl.querySelector('.dr-row-actions button[data-action="reveal"]');
	check('hover: reveal button uses folder svg (no more ⌘ text)', !!revealBtn && revealBtn.querySelector('svg') !== null && !revealBtn.textContent.includes('⌘'));
	// tooltip must appear on the SAME tick as hover — no setTimeout
	const before = document.querySelectorAll('.dr-tip').length;
	await act(async () => { revealBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
	const tip = document.querySelector('.dr-tip');
	check('hover: tooltip appears immediately on mouseover', before === 0 && !!tip && tip.textContent === 'panel.revealInFinder', tip?.textContent);
	// moving onto the button's own svg glyph must NOT hide it (relatedTarget inside the button)
	const svg = revealBtn.querySelector('svg');
	await act(async () => { revealBtn.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: svg })); });
	check('hover: keeps showing over own glyph', !!document.querySelector('.dr-tip'));
	// leaving the button entirely hides it
	await act(async () => { revealBtn.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
	check('hover: tooltip hides on mouseout', !document.querySelector('.dr-tip'));
	localStorage.removeItem('dsh-doc-reader:recent');
	await act(async () => { root.render(React.createElement(Panel)); });
	await act(async () => { await sleep(60); });
}


// ---------- 21. quote bridge + selection → chat ----------
{
	// the dock-bridge component must exist and capture inputActions from props
	const Bridge = componentRefs['conversation.composer.dock'];
	check('bridge: dock component registered', typeof Bridge === 'function');
	const captured = [];
	const fakeActions = { insertQuote: (text) => { captured.push(text); return true; } };
	// keep the bridge mounted on its own root: rendering the Panel on `root`
	// would unmount it and drop the captured actions again
	const bridgeHost = document.createElement('div');
	document.body.appendChild(bridgeHost);
	const bridgeRoot = createRoot(bridgeHost);
	await act(async () => { bridgeRoot.render(React.createElement(Bridge, { inputActions: fakeActions, sessionId: 's1' })); });
	await act(async () => { await sleep(30); });
	// bridge now holds actions; open a doc and select text via the DOM
	files.set('/tmp/quote.md', { status: 200, body: '# QuoteDoc\n\nalpha selection target\n' });
	await act(async () => { root.render(React.createElement(Panel)); });
	await typeIntoPath('/tmp/quote.md');
	await act(async () => { await sleep(120); });
	const sel = document.getSelection();
	const range = document.createRange();
	// pick the DEEPEST leaf carrying the text: ancestors match textContent too and
	// would select the whole panel
	const textNode = [...rootEl.querySelectorAll('.dr-content *')]
		.filter((el) => el.textContent.includes('alpha selection target') && el.children.length === 0).pop();
	check('bridge: selectable text rendered', !!textNode);
	if (textNode) {
		range.selectNodeContents(textNode);
		sel.removeAllRanges();
		sel.addRange(range);
		document.dispatchEvent(new dom.window.Event('selectionchange'));
		await act(async () => { await sleep(220); });
		const bar = rootEl.querySelector('[data-doc-reader-selbar]');
		check('selbar: action bar appears on selection', !!bar && bar.querySelectorAll('button').length === 4);
		// instant tooltip below a bar button
		const copyBtn = bar.querySelector('[data-selbar-action="copy"]');
		await act(async () => { copyBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
		const barTip = document.querySelector('.dr-tip--below');
		check('selbar: instant tooltip on hover', !!barTip && barTip.textContent === 'panel.menuCopy', barTip?.textContent);
		check('selbar: tooltip at body level (no panel stacking occlusion)', !!barTip && barTip.parentElement === document.body);
		await act(async () => { copyBtn.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
		check('selbar: tooltip hides on leave', !document.querySelector('.dr-tip--below'));
		const btn = bar.querySelector('[data-selbar-action="quote"]');
		await act(async () => { btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
		await act(async () => { await sleep(60); });
		check('bridge: click quotes blockquote into composer', captured.length === 1 && captured[0].includes('> 《quote.md》') && captured[0].includes('> alpha selection target'), JSON.stringify(captured).slice(0, 120));
		check('bridge: selection cleared after quoting', document.getSelection().isCollapsed);
		// bar search routes into the viewbar, bar translate opens the dialog
		range.selectNodeContents(textNode);
		sel.removeAllRanges();
		sel.addRange(range);
		document.dispatchEvent(new dom.window.Event('selectionchange'));
		await act(async () => { await sleep(220); });
		const bar2 = rootEl.querySelector('[data-doc-reader-selbar]');
		let translated = null;
		routeHandlers.set('/translate', async (url, opts) => { translated = JSON.parse(opts.body); return respond(200, JSON.stringify({ ok: true, text: '选区条翻译' })); });
		await act(async () => { bar2.querySelector('[data-selbar-action="translate"]').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
		await act(async () => { await sleep(80); });
		check('selbar: translate action opens dialog', !!rootEl.querySelector('[data-doc-reader-translate]') && translated?.text?.includes('alpha selection target'));
		const closeT = [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'panel.close');
		await act(async () => { closeT.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
		routeHandlers.delete('/translate');
		sel.removeAllRanges();
	}
	await act(async () => { bridgeRoot.unmount(); });
	bridgeHost.remove();
}

// ---------- 22. content context menu ----------
{
	files.set('/tmp/menu.md', { status: 200, body: '# MenuDoc\n\nmenu target words here\n' });
	await typeIntoPath('/tmp/menu.md');
	await act(async () => { await sleep(120); });
	const content = rootEl.querySelector('.dr-content');
	check('menu: content area present', !!content);
	await act(async () => { content.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 30 })); });
	const menu = rootEl.querySelector('[data-doc-reader-menu]');
	check('menu: opens on contextmenu', !!menu);
	check('menu: reveal entry always present', menu.textContent.includes('panel.revealInFinder'));
	check('menu: selection entries absent without selection', !menu.textContent.includes('panel.quoteToChat'));
	await act(async () => { rootEl.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true })); });
	await act(async () => { await sleep(30); });
	check('menu: closes on outside click', !rootEl.querySelector('[data-doc-reader-menu]'));
	// with a selection the action rows appear
	const sel = document.getSelection();
	const range = document.createRange();
	const node = [...rootEl.querySelectorAll('.dr-content *')]
		.filter((el) => el.textContent.includes('menu target words') && el.children.length === 0).pop();
	range.selectNodeContents(node);
	sel.removeAllRanges();
	sel.addRange(range);
	await act(async () => { content.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })); });
	const menu2 = rootEl.querySelector('[data-doc-reader-menu]');
	check('menu: selection rows appear', !!menu2 && menu2.textContent.includes('panel.quoteToChat') && menu2.textContent.includes('panel.menuSearchInDoc'));
	// "search in document" fills the viewbar search input
	const searchBtn = [...menu2.querySelectorAll('button')].find((b) => b.textContent.includes('panel.menuSearchInDoc'));
	await act(async () => { searchBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(60); });
	const searchInput = rootEl.querySelector('.dr-viewbar input[type="search"], .dr-viewbar input[type="text"]');
	check('menu: search-in-doc fills the search box', !!searchInput && searchInput.value === 'menu target words here', searchInput?.value);
	sel.removeAllRanges();
}

// ---------- 23. @doc input-trigger source ----------
{
	const src = registeredSources.find((s) => s && s.name === 'doc-reader');
	check('atdoc: source registered', !!src && src.trigger === '@');
	localStorage.setItem('dsh-doc-reader:recent', JSON.stringify([
		{ path: '/tmp/at-one.md', kind: 'markdown', at: Date.now() },
		{ path: '/tmp/at-two.pdf', kind: 'pdf', at: Date.now() - 1000 },
	]));
	let rows = await src.candidates({}, { query: '' });
	check('atdoc: lists recent documents', rows.length === 2 && rows[0].name === 'at-one.md' && rows[0].section === 'panel.atDocs');
	rows = await src.candidates({}, { query: 'two' });
	check('atdoc: filters by query', rows.length === 1 && rows[0].name === 'at-two.pdf');
	const pick = src.onPick({ candidate: rows[0] });
	check('atdoc: pick returns atomic insert', pick?.insert?.source === 'doc-reader' && pick.insert.ref === '/tmp/at-two.pdf' && pick.insert.clipboardText === '/tmp/at-two.pdf');
	check('atdoc: codec serializes to the plain path', await src.codec.serialize('/tmp/at-two.pdf') === '/tmp/at-two.pdf');
	check('atdoc: openReference opens the reader', src.openReference({}, { ref: '/tmp/quote.md' }) === true);
	// consume the parked open request now: leaving it pending would 404 on the
	// next Panel remount and leak an error flash into later scenes
	await act(async () => { root.render(React.createElement(Panel)); });
	await act(async () => { await sleep(150); });
	check('atdoc: pending open consumed', rootEl.querySelector('.dr-rename-name')?.textContent === 'quote.md', rootEl.querySelector('.dr-rename-name')?.textContent);
	check('atdoc: openReference rejects unknown kinds', src.openReference({}, { ref: '/tmp/nope.exe' }) === false);
	localStorage.removeItem('dsh-doc-reader:recent');
}


// ---------- 24. global shortcut + office view ----------
{
	// shortcut registration and run() → focus the path input
	const cmd = registeredShortcuts.find((c) => c && c.id === 'doc-reader.open');
	check('shortcut: command registered', !!cmd && cmd.defaults['desktop:macos'].code === 'KeyO');
	const resolution = cmd.resolve({});
	check('shortcut: resolves handled', resolution.status === 'handled');
	await act(async () => { resolution.run(); });
	await act(async () => { await sleep(90); });
	check('shortcut: run focuses the path input', document.activeElement === rootEl.querySelector('.dr-path'));

	// office view: conversion failure shows a clear error
	routeHandlers.set('/convert', async (url) => respond(502, JSON.stringify({ error: '文档转换引擎不可用' })));
	files.set('/tmp/deck.pptx', { status: 200, body: 'PK' });
	await typeIntoPath('/tmp/deck.pptx');
	await act(async () => { await sleep(150); });
	check('office: conversion failure surfaces error', rootEl.textContent.includes('文档转换引擎不可用'), rootEl.textContent.slice(0, 90));

	// office view: success hands the cached pdf path to the renderer
	let convertRequested = '';
	routeHandlers.set('/convert', async (url) => {
		convertRequested = decodeURIComponent(url.split('path=')[1] ?? '');
		return respond(200, JSON.stringify({ ok: true, pdfPath: '/tmp/conv-cache/deadbeef.pdf' }));
	});
	files.set('/tmp/sheet.xlsx', { status: 200, body: 'PK' });
	await typeIntoPath('/tmp/sheet.xlsx');
	await act(async () => { await sleep(150); });
	check('office: requests host conversion for the xlsx', convertRequested === '/tmp/sheet.xlsx', convertRequested);
	routeHandlers.delete('/convert');
}


// ---------- 25. EPUB chapter CSS scoping + whole-book search ----------
{
	const ZipLib = require('jszip');
	const zip = new ZipLib();
	zip.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
	zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="2.0"><manifest>'
		+ '<item id="css" href="style.css" media-type="text/css"/>'
		+ '<item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/>'
		+ '<item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/>'
		+ '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest>'
		+ '<spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>');
	zip.file('OEBPS/style.css', 'body { margin: 0 } p { text-indent: 1em } @import url("evil.css"); .chapter { font-weight: bold } @media print { p { color: red } }');
	zip.file('OEBPS/toc.ncx', '<?xml version="1.0"?><ncx><navMap>'
		+ '<navPoint><navLabel><text>Chapter One</text></navLabel><content src="c1.xhtml"/></navPoint>'
		+ '<navPoint><navLabel><text>Chapter Two</text></navLabel><content src="c2.xhtml"/></navPoint></navMap></ncx>');
	zip.file('OEBPS/c1.xhtml', '<html><head><link rel="stylesheet" href="style.css"/></head><body><p class="chapter">第一章 alpha text</p></body></html>');
	zip.file('OEBPS/c2.xhtml', '<html><head><link rel="stylesheet" type="text/css" href="style.css"/></head><body><p>第二章 bravo needle words</p></body></html>');
	const buf = await zip.generateAsync({ type: 'arraybuffer' });
	files.set('/tmp/book.epub', { status: 200, body: buf });
	await typeIntoPath('/tmp/book.epub');
	await act(async () => { await sleep(250); });
	// chapter CSS loaded, scoped to the container, @import dropped
	const styleEl = rootEl.querySelector('.dr-epub-ch > style');
	const cssText = styleEl?.textContent ?? '';
	check('epub-css: stylesheet injected', !!styleEl && cssText.includes('text-indent'));
	check('epub-css: selectors scoped', cssText.includes('.dr-epub-ch p') && cssText.includes('.dr-epub-ch .chapter'));
	check('epub-css: body mapped to scope', /\.dr-epub-ch\s*\{/.test(cssText));
	check('epub-css: @import dropped, @media kept', !cssText.includes('@import') && cssText.includes('@media'));
	// whole-book search: chapter 1 has no hit → Enter hops to chapter 2 and highlights
	const input = searchInput();
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
	await act(async () => {
		setter.call(input, 'needle');
		input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	});
	await act(async () => {
		input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	});
	await act(async () => { await sleep(300); });
	
	// jsdom renders the chapter-hop chain slowly — poll for the article
	for (let w = 0; w < 25 && !rootEl.querySelector('.dr-epub-ch'); w++) await act(async () => { await sleep(100); });
	check('epub-search: hopped to the chapter with the hit', rootEl.textContent.includes('bravo needle words') && rootEl.textContent.includes('2/2'), rootEl.querySelector('.dr-badge')?.textContent ?? rootEl.textContent.slice(0, 60));
	check('epub-search: match highlighted', !!rootEl.querySelector('.dr-epub-ch mark.dr-mark'));
	check('epub-search: jump status flashed', rootEl.textContent.includes('panel.searchJumped'));
}

// ---------- 26. selection translate ----------
{
	files.set('/tmp/tr.md', { status: 200, body: '# TrDoc\n\nsome english paragraph to translate\n' });
	await typeIntoPath('/tmp/tr.md');
	await act(async () => { await sleep(120); });
	const content = rootEl.querySelector('.dr-content');
	const sel = document.getSelection();
	const range = document.createRange();
	const node = [...rootEl.querySelectorAll('.dr-content *')].filter((el) => el.textContent.includes('some english') && el.children.length === 0).pop();
	range.selectNodeContents(node);
	sel.removeAllRanges();
	sel.addRange(range);
	await act(async () => { content.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 })); });
	const menu = rootEl.querySelector('[data-doc-reader-menu]');
	check('translate: menu entry with selection', !!menu && menu.textContent.includes('panel.translate'));
	let posted = null;
	routeHandlers.set('/translate', async (url, opts) => { posted = JSON.parse(opts.body); return respond(200, JSON.stringify({ ok: true, text: '某段英文的中文翻译' })); });
	const btn = [...menu.querySelectorAll('button')].find((b) => b.textContent.includes('panel.translate'));
	await act(async () => { btn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(80); });
	check('translate: posts selection + default target', posted?.text?.includes('some english') && posted?.targetLanguage === 'zh-Hans', JSON.stringify(posted));
	check('translate: overlay shows result', !!rootEl.querySelector('[data-doc-reader-translate]') && rootEl.querySelector('[data-doc-reader-translate]').textContent.includes('某段英文的中文翻译'));
	check('translate: overlay shows the source selection', rootEl.querySelector('[data-doc-reader-translate-source]')?.textContent.includes('some english paragraph'));
	const closeBtn = [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'panel.close');
	await act(async () => { closeBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	check('translate: overlay closes', !rootEl.querySelector('[data-doc-reader-translate]'));
	routeHandlers.set('/translate', async () => respond(503, JSON.stringify({ error: '翻译服务不可用(experimental-translator 未挂载)' })));
	range.selectNodeContents(node);
	sel.removeAllRanges();
	sel.addRange(range);
	await act(async () => { content.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 25, clientY: 25 })); });
	const btn2 = [...rootEl.querySelectorAll('[data-doc-reader-menu] button')].find((b) => b.textContent.includes('panel.translate'));
	await act(async () => { btn2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(80); });
	// settings expose the engine switch
	const gear = btnByTitle('panel.settings');
	await act(async () => { gear.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	const selects = [...rootEl.querySelectorAll('select')];
	const engineSel = selects.find((s) => [...s.options].some((o) => o.value === 'dsh'));
	check('translate: engine select in settings', !!engineSel && [...engineSel.options].some((o) => o.value === 'google'));
	check('translate: translateTarget label localized',
		(registeredLocales.zh?.['panel.translateTarget'] === '翻译目标语言')
		&& (registeredLocales['zh-tw']?.['panel.translateTarget'] === '翻譯目標語言')
		&& (registeredLocales.en?.['panel.translateTarget'] === 'Translate into'),
		JSON.stringify(registeredLocales.zh?.['panel.translateTarget']));
	await act(async () => { [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'panel.cancel')?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	check('translate: failure surfaces in overlay', rootEl.textContent.includes('翻译服务不可用'));
	// retry: flip the mock to success and press the retry button
	routeHandlers.set('/translate', async (url, opts) => respond(200, JSON.stringify({ ok: true, text: '重试后的译文' })));
	const retryBtn = rootEl.querySelector('[data-doc-reader-translate-retry]');
	check('translate: retry button on error', !!retryBtn);
	await act(async () => { retryBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(80); });
	check('translate: retry refetches', rootEl.querySelector('[data-doc-reader-translate]')?.textContent.includes('重试后的译文'));
	// copy feedback: button text flips to 已复制
	const copyBtn = rootEl.querySelector('[data-doc-reader-translate-copy]');
	check('translate: copy button present', !!copyBtn);
	await act(async () => { copyBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	check('translate: copy feedback shows', copyBtn.textContent.trim() === 'panel.copied', copyBtn.textContent);
	await act(async () => { await sleep(1700); });
	check('translate: copy feedback resets', copyBtn.textContent.trim() === 'panel.translateCopy', copyBtn.textContent);
	routeHandlers.delete('/translate');
	sel.removeAllRanges();
	const closeBtn2 = [...rootEl.querySelectorAll('button')].find((b) => b.getAttribute('title') === 'panel.close');
	if (closeBtn2) await act(async () => { closeBtn2.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
}

// ---------- 26. toolbar: copy-path button + instant tooltips ----------
{
	// fresh panel, no file open → the copy-path button must render disabled
	// (plain re-render keeps the previous scene's open file: unmount first)
	await act(async () => { root.render(React.createElement('div')); });
	await act(async () => { root.render(React.createElement(Panel)); });
	await act(async () => { await sleep(80); });
	let copyBtn = rootEl.querySelector('[data-doc-reader-copy-path]');
	check('toolbar: copy-path button present', !!copyBtn);
	check('toolbar: copy-path disabled with no file open', copyBtn?.disabled === true);
	// open a file → enabled, and placed between the path input and the sidebar toggle
	files.set('/tmp/copypath.md', { status: 200, body: '# CopyMe\n' });
	await typeIntoPath('/tmp/copypath.md');
	await act(async () => { await sleep(120); });
	copyBtn = rootEl.querySelector('[data-doc-reader-copy-path]');
	check('toolbar: copy-path enabled with file open', copyBtn?.disabled === false);
	const toolbarKids = [...rootEl.querySelector('.dr-toolbar').children];
	check('toolbar: copy button sits after path input, before toggle',
		toolbarKids.indexOf(rootEl.querySelector('.dr-path')) < toolbarKids.indexOf(copyBtn)
		&& toolbarKids.indexOf(copyBtn) < toolbarKids.findIndex((el) => el.getAttribute('aria-label') === 'panel.toggleSide'),
		toolbarKids.map((el) => el.className || el.tagName).join('|'));
	// instant tooltips replace the delayed native one: aria-label kept, title gone
	const sideBtn = [...rootEl.querySelectorAll('.dr-toolbar .dr-btn')].find((b) => b.getAttribute('aria-label') === 'panel.toggleSide');
	const gearBtn = [...rootEl.querySelectorAll('.dr-toolbar .dr-btn')].find((b) => b.getAttribute('aria-label') === 'panel.settings');
	check('toolbar: instant-tip buttons drop native title',
		[copyBtn, sideBtn, gearBtn].every((b) => b && b.getAttribute('title') === null && !!b.getAttribute('aria-label')));
	// hover → dark side-anchored bubble at document.body (platform sidebar-toggle
	// pattern): right-side icons anchor LEFT of the button, rename anchors RIGHT
	const tipL = () => document.querySelector('.dr-tip--side-l');
	const tipR = () => document.querySelector('.dr-tip--side-r');
	const pathInputEl = rootEl.querySelector('.dr-path');
	check('toolbar: path input mounted (hint slot anchor)', !!pathInputEl);
	await act(async () => { copyBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
	check('toolbar: copy-path bubble on hover (side-left)', tipL()?.textContent === 'panel.copyPath', tipL()?.textContent);
	// dedupe: re-fired mouseover (cursor crossing the button's own svg glyph)
	// must NOT destroy and recreate the tooltip element (DOM churn = flicker)
	const tipElBefore = document.querySelector('.dr-tip--side-l');
	await act(async () => { copyBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
	await act(async () => { copyBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
	check('toolbar: repeated hover reuses the same tooltip element', document.querySelector('.dr-tip--side-l') === tipElBefore);
	check('toolbar: bubble at body level', !!tipL() && tipL().parentElement === document.body);
	await act(async () => { copyBtn.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
	check('toolbar: bubble clears on leave', !document.querySelector('.dr-tip'));
	await act(async () => { sideBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
	check('toolbar: sidebar toggle bubble on hover', tipL()?.textContent === 'panel.toggleSide', tipL()?.textContent);
	await act(async () => { sideBtn.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
	await act(async () => { gearBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
	check('toolbar: settings bubble on hover', tipL()?.textContent === 'panel.settings', tipL()?.textContent);
	await act(async () => { gearBtn.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
	// rename (left end of the toolbar) anchors its bubble to the RIGHT
	const renameBtn = rootEl.querySelector('.dr-rename-btn');
	await act(async () => { renameBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
	check('toolbar: rename bubble anchors right', tipR()?.textContent === 'panel.renameFile', tipR()?.textContent);
	await act(async () => { renameBtn.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
	// focusing the path input must NOT suppress the explanation (the bubble no
	// longer covers the input, so there is nothing to protect)
	const pathInput = rootEl.querySelector('.dr-path');
	await act(async () => { pathInput.focus(); });
	await act(async () => { gearBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
	check('toolbar: hint shows while path input focused', tipL()?.textContent === 'panel.settings', tipL()?.textContent);
	await act(async () => { gearBtn.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
	await act(async () => { pathInput.blur(); });
	check('toolbar: no chip element remains', !rootEl.querySelector('[data-doc-reader-bar-hint]'));
	// REAL-GEOMETRY placement check: jsdom rects are all-zero by default, which
	// hides x-position bugs (the live bug: one icon's bubble hugged the button
	// while the others used the fixed slot). Give the toolbar realistic rects and
	// assert all three icons produce the IDENTICAL slot x = input right border.
	const elProto = dom.window.Element.prototype;
	const realGBCR = elProto.getBoundingClientRect;
	const rect = (l, t, w, hgt) => ({ left: l, right: l + w, top: t, bottom: t + hgt, width: w, height: hgt, x: l, y: t, toJSON: () => {} });
	elProto.getBoundingClientRect = function () {
		const label = this.getAttribute?.('aria-label');
		if (this.classList?.contains('dr-path')) return rect(760, 8, 400, 30);
		if (this.classList?.contains('dr-rename-btn')) return rect(786, 8, 114, 28);
		if (label === 'panel.copyPath') return rect(1168, 8, 28, 28);
		if (label === 'panel.toggleSide') return rect(1204, 8, 28, 28);
		if (label === 'panel.settings') return rect(1240, 8, 28, 28);
		return realGBCR.call(this);
	};
	const slotXs = [];
	for (const b of [copyBtn, sideBtn, gearBtn]) {
		await act(async () => { b.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
		const t = document.querySelector('.dr-tip--side-l');
		slotXs.push(t?.style.left ?? 'missing');
		await act(async () => { b.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
	}
	// product requirement (confirmed): ALL three bubbles share ONE fixed slot —
	// right border exactly on the input's right border (1160px), identical for
	// every icon, never degrading to per-button hugging (1160/1196/1232)
	check('toolbar: all three bubbles fixed at the input right border (1160px)',
		slotXs.length === 3 && slotXs.every((v) => v === '1160px'), slotXs.join(','));
	await act(async () => { renameBtn.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
	check('toolbar: rename bubble sits 8px right of the button (908px)',
		document.querySelector('.dr-tip--side-r')?.style.left === '908px', document.querySelector('.dr-tip--side-r')?.style.left);
	await act(async () => { renameBtn.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
	// clamp-path regression: the on-screen clamp must never move a side-l
	// bubble's RIGHT edge off the slot line. Mock a 160px bubble and a viewport
	// only 80px wider than the slot (old code subtracted the width and pulled
	// long labels off the line — the live misalignment).
	const htmlProto = dom.window.HTMLElement.prototype;
	const realOW = Object.getOwnPropertyDescriptor(htmlProto, 'offsetWidth');
	Object.defineProperty(htmlProto, 'offsetWidth', { get() { return this.classList?.contains('dr-tip') ? 160 : 0; }, configurable: true });
	const realIW = dom.window.innerWidth;
	Object.defineProperty(dom.window, 'innerWidth', { value: 1240, configurable: true });
	const clampedXs = [];
	for (const b of [copyBtn, sideBtn, gearBtn]) {
		await act(async () => { b.dispatchEvent(new dom.window.MouseEvent('mouseover', { bubbles: true })); });
		const t = document.querySelector('.dr-tip--side-l');
		clampedXs.push(t?.style.left ?? 'missing');
		await act(async () => { b.dispatchEvent(new dom.window.MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })); });
	}
	check('toolbar: slot alignment holds when the viewport barely fits (w=160, vw=1240)',
		clampedXs.length === 3 && clampedXs.every((v) => v === '1160px'), clampedXs.join(','));
	Object.defineProperty(dom.window, 'innerWidth', { value: realIW, configurable: true });
	if (realOW) Object.defineProperty(htmlProto, 'offsetWidth', realOW);
	elProto.getBoundingClientRect = realGBCR;
	// click → copies the OPEN path (not the input draft) and flashes feedback
	const nav = dom.window.navigator;
	const origClipboard = nav.clipboard;
	const copiedTexts = [];
	nav.clipboard = { writeText: async (t) => { copiedTexts.push(t); } };
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
	await act(async () => {
		const pathInput = rootEl.querySelector('.dr-path');
		setter.call(pathInput, '/tmp/not-open-yet.md'); // simulate an edited, un-entered draft
		pathInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	});
	await act(async () => { copyBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(30); });
	check('toolbar: click copies the open file path', copiedTexts.length === 1 && copiedTexts[0] === '/tmp/copypath.md', JSON.stringify(copiedTexts));
	check('toolbar: copy flashes feedback', rootEl.textContent.includes('panel.copied'));
	nav.clipboard = origClipboard;
	// locale dicts carry the new key in all three languages
	check('image: default position centers via flex auto margins (source CSS)',
		(() => { const css = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'); return /.dr-image-host\{display:flex;min-height:100%/.test(css) && !/.dr-image-host\{[^}]*flex-start/.test(css) && /.dr-image-stage\{[^}]*margin:auto/.test(css); })(),
		'image host/stage CSS changed');
	check('toolbar: copyPath string localized',
		registeredLocales.en?.['panel.copyPath'] === 'Copy file path'
		&& registeredLocales.zh?.['panel.copyPath'] === '复制文件路径'
		&& registeredLocales['zh-tw']?.['panel.copyPath'] === '複製文件路徑',
		JSON.stringify(registeredLocales.zh?.['panel.copyPath']));
}

// ---------- 27. image view: transform anchoring ----------
{
	// the <img> keeps NATURAL layout size; the visual scale/rotate must anchor
	// at its top-left (plus a display-unit translate for 90/180/270) — origin
	// center drew the picture around the layout box center, thousands of px
	// right of the stage (the "empty stage, image off-screen" bug).
	files.set('/tmp/big.png', { status: 200, body: Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex') });
	await typeIntoPath('/tmp/big.png');
	await act(async () => { await sleep(80); });
	const img = rootEl.querySelector('.dr-image-stage img');
	check('image: view renders img', !!img);
	await act(async () => {
		Object.defineProperty(img, 'naturalWidth', { value: 2560, configurable: true });
		Object.defineProperty(img, 'naturalHeight', { value: 1088, configurable: true });
		img.dispatchEvent(new dom.window.Event('load', { bubbles: false }));
	});
	await act(async () => { await sleep(40); });
	// jsdom has no layout → scroll clientWidth is 0 → fit-window clamps to 0.1
	check('image: transform anchored top-left (scale only)', img?.style.transform === 'scale(0.1)', img?.style.transform);
	const rotR = btnByTitle('panel.rotateRight');
	await act(async () => { rotR.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
	await act(async () => { await sleep(20); });
	check('image: 90° keeps visual inside the swapped stage',
		img?.style.transform === 'translate(108.8px, 0px) rotate(90deg) scale(0.1)', img?.style.transform);
	check('image: css transform-origin stays top-left',
		(() => { const css = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8'); return /\.dr-image-stage img\{[^}]*transform-origin:0 0/.test(css); })());
	files.delete('/tmp/big.png');
}

const fails = results.filter((x) => !x.ok);
console.log(fails.length === 0 ? `\nCLIENT TESTS: ${results.length} ALL PASS` : `\nCLIENT TESTS: ${fails.length}/${results.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
