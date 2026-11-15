// Smoke test: load the doc-reader client factory, mount the main panel in
// jsdom, open a markdown file (utf-8 + gbk), and exercise the rename UI.
// Deps (jsdom/react/react-dom) resolve from the CURRENT directory — run it
// from the vendor build dir:   cd /tmp/dsh-vendor-build && node <this file>
// NOTE: react/react-dom must be required only AFTER the jsdom globals are
// installed below — react-dom's load-time capability checks otherwise take
// the non-DOM branch and its event system breaks on real events.
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(pathToFileURL(process.cwd() + '/'));
const { JSDOM } = require('jsdom');

// url option avoids "localStorage is not available for opaque origins"
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { pretendToBeVisual: true, url: 'http://localhost/' });
global.window = dom.window;
global.document = dom.window.document;
global.localStorage = dom.window.localStorage;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.AbortController = dom.window.AbortController;
// DOMParser/TextDecoder globals the client relies on (browser-builtins in the real GUI)
global.DOMParser = dom.window.DOMParser;
if (typeof global.URL.createObjectURL !== 'function') global.URL = dom.window.URL;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = dom.window.TextDecoder;

// react-dom AFTER jsdom globals (see header note)
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react-dom/test-utils');

let capturedFactory;
global.window.__ModuleLoader__ = { load: (m) => { capturedFactory = m.factory; } };

// evaluate client.js (it references window.__ModuleLoader__ at top level)
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
new Function('window', 'document', 'localStorage', 'requestAnimationFrame', source)(
	global.window, global.document, global.localStorage, global.requestAnimationFrame);

// fake markdown-it vendor so the markdown path runs without the real chunk;
// JSZip is real so the epub pipeline is exercised end-to-end
const fakeVendor = {
	MarkdownIt: class MarkdownIt {
		constructor() { this.renderer = { rules: {} }; }
		render(text) {
			return text.split('\n').map((line) => (line.startsWith('# ')
				? `<h1>${line.slice(2)}</h1>` : `<p>${line}</p>`)).join('');
		}
	},
	JSZip: require('jszip'),
	loadDocx: () => ({ renderAsync: async () => {} }),
};

// componentRefs keyed by slot name: the main panel registers with
// { name:'main', key:'doc-reader' } and the sidebar entry reuses id
// 'doc-reader' — keying by name keeps them from overwriting each other.
const componentRefs = {};
const ctx = {
	effect: (fn) => { try { fn(); } catch {} return () => {}; },
	logger: { warn: () => {} },
	locale: {
		register: () => () => {},
		bind: () => (key) => key,
	},
	slots: {
		inject: (name, cb) => { try { cb(); } catch (e) { console.error('inject failed', name, e.message); } },
		register: (options, Component) => { componentRefs[options.name] = Component; return () => {}; },
	},
};

const requireStub = (spec) => {
	if (spec === 'react') return React;
	throw new Error('unexpected require: ' + spec);
};
requireStub.async = async () => fakeVendor;

const exports_ = capturedFactory(requireStub);
exports_.apply(ctx);

console.log('registered components:', Object.keys(componentRefs));
const Panel = componentRefs['main'];
if (!Panel) throw new Error('main panel not registered');

global.IS_REACT_ACT_ENVIRONMENT = true;
const root = createRoot(document.getElementById('host'));
await act(async () => { root.render(React.createElement(Panel)); });
const rootEl = document.getElementById('host');
console.log('panel mounted:', !!rootEl.querySelector('.dr-panel'));
if (!rootEl.querySelector('.dr-panel')) throw new Error('panel did not mount');

// stub fetch: the client decodes text from arrayBuffer (multi-encoding path)
const MD = '# T1\nhello world';
const encoder = new TextEncoder();
const makeRes = (body, type) => ({ ok: true, status: 200, arrayBuffer: async () => body, text: async () => '', json: async () => ({}) });
let nextBody = encoder.encode(MD).buffer;
global.fetch = async (url) => {
	if (String(url).includes('/file/')) return makeRes(nextBody);
	return { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(0), json: async () => ({}) };
};
dom.window.fetch = global.fetch;

const typeIntoPath = async (value) => {
	const pathInput = rootEl.querySelector('.dr-path');
	if (!pathInput) throw new Error('path input not found');
	const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
	await act(async () => {
		setter.call(pathInput, value);
		pathInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
	});
	await act(async () => {
		pathInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
	});
	await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
};

await typeIntoPath('/tmp/sample.md');
const titleOk = !!rootEl.querySelector('.dr-rename-name')?.textContent;
console.log('title after open:', rootEl.querySelector('.dr-rename-name')?.textContent);
const article = rootEl.querySelector('.dr-md');
console.log('markdown rendered:', !!article, '| has heading:', !!(article && article.querySelector('h1')));

// gbk bytes for 你好世界 (NI HAO SHI JIE in GBK encoding)
const GBK_BYTES = new Uint8Array([0xC4, 0xE3, 0xBA, 0xC3, 0xCA, 0xC0, 0xBD, 0xE7, 0x0A]);
nextBody = GBK_BYTES.buffer.slice(GBK_BYTES.byteOffset, GBK_BYTES.byteOffset + GBK_BYTES.byteLength);
await typeIntoPath('/tmp/gbk.txt');
const pre = rootEl.querySelector('.dr-text');
console.log('gbk text decoded:', pre?.textContent?.includes('你好世界'), '| got:', JSON.stringify(pre?.textContent));

const renameBtn = rootEl.querySelector('.dr-rename-btn');
console.log('rename button present:', !!renameBtn, '| disabled:', renameBtn?.disabled);
if (renameBtn) {
	await act(async () => {
		renameBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
	});
	console.log('rename input after click:', !!rootEl.querySelector('.dr-rename-input'));
}
const fails = [];
if (!titleOk) fails.push('open');
if (!article || !article.querySelector('h1')) fails.push('markdown render');
if (!pre?.textContent?.includes('你好世界')) fails.push('gbk decode');
if (!renameBtn) fails.push('rename button');
// handoff action renders for supported kinds and hides for others
const Handoff = componentRefs['sidebar.right.tab.document.actions'];
if (!Handoff) fails.push('handoff not registered');
else {
	const mount = async (p) => {
		const host = document.createElement('div');
		document.body.appendChild(host);
		const r2 = createRoot(host);
		await act(async () => { r2.render(React.createElement(Handoff, { absolutePath: p })); });
		return host;
	};
	const good = await mount('/tmp/report.pdf');
	const bad = await mount('/tmp/tool.exe');
	console.log('handoff button for pdf:', !!good.querySelector('button'), '| exe renders null:', bad.childElementCount === 0);
	if (!good.querySelector('button')) fails.push('handoff button');
	if (bad.childElementCount !== 0) fails.push('handoff kind filter');
}
if (fails.length) { console.error('SMOKE FAIL:', fails.join(', ')); process.exit(1); }

// epub: build a minimal real book, open it, assert chapter render + nav
{
	const JSZip = require('jszip');
	const zip = new JSZip();
	zip.file('mimetype', 'application/epub+zip');
	zip.file('META-INF/container.xml', `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
	zip.file('OEBPS/content.opf', `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title><dc:identifier id="id">x</dc:identifier></metadata>
  <manifest>
    <item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="img/pic.png" media-type="image/png"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>`);
	zip.file('OEBPS/ch1.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c1</title></head>
<body><h1>第一章</h1><p>hello epub</p><img src="img/pic.png"/><script>alert(1)</script></body></html>`);
	zip.file('OEBPS/ch2.xhtml', `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>c2</title></head>
<body><p>第二章 content</p></body></html>`);
	zip.file('OEBPS/img/pic.png', Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082', 'hex'));
	nextBody = await zip.generateAsync({ type: 'arraybuffer' });
	await typeIntoPath('/tmp/book.epub');
	await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
	const art = rootEl.querySelector('.dr-md');
	const badge = [...rootEl.querySelectorAll('.dr-badge')].map((b) => b.textContent).join(',');
	console.log('epub chapter1 rendered:', !!art, '| has 第一章:', !!art?.textContent?.includes('第一章'),
		'| script stripped:', !art?.querySelector('script'),
		'| img blob:', (art?.querySelector('img')?.getAttribute('src') || '').startsWith('blob:'),
		'| badge:', badge);
	if (!art || !art.textContent?.includes('第一章')) fails.push('epub render');
	if (art?.querySelector('script')) fails.push('epub sanitize');
	if (!(art?.querySelector('img')?.getAttribute('src') || '').startsWith('blob:')) fails.push('epub image');
	const nextBtn = [...rootEl.querySelectorAll('.dr-btn')].find((b) => b.getAttribute('title') === 'panel.nextPage');
	if (nextBtn) {
		await act(async () => { nextBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
		await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
		const art2 = rootEl.querySelector('.dr-md');
		console.log('epub chapter2 after next:', !!art2?.textContent?.includes('第二章'));
		if (!art2?.textContent?.includes('第二章')) fails.push('epub chapter nav');
	} else fails.push('epub nav button');
}
if (fails.length) { console.error('SMOKE FAIL:', fails.join(', ')); process.exit(1); }
console.log('SMOKE PASS');
process.exit(0);
