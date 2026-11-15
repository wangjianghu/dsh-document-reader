// Host half of the DSH doc-reader plugin.
//
// Registers two read-only loopback endpoints on the DSH web server:
//   GET /doc-reader/dsh-document-reader/file/<encoded absolute path>
//       -> file bytes for the supported document extensions
//   GET /doc-reader/dsh-document-reader/list?path=<encoded absolute dir>
//       -> JSON directory listing (files + directories)
//
// This mirrors the VSCode extension behaviour (open any local file), served
// only to same-host requests of the loopback web GUI. Only whitelisted
// document extensions are readable; arbitrary code/config files stay out.

import { createReadStream } from 'node:fs';
import { readFile, stat, lstat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { mkdirSync, readFileSync, renameSync, watch, writeFileSync } from 'node:fs';

const ROUTE = '/doc-reader/dsh-document-reader';

const TEXTUAL = new Set(['.md', '.markdown', '.txt', '.log', '.json', '.yaml', '.yml', '.csv', '.tsv', '.xml', '.ini', '.conf', '.toml']);
const IMAGES = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.avif', '.jfif']);
const OFFICE = new Set(['.pptx', '.xlsx', '.ppt', '.xls', '.doc']);
const BINARY = new Set(['.pdf', '.docx', '.epub', '.html', '.htm', ...OFFICE]);
const READABLE = new Set([...TEXTUAL, ...IMAGES, ...BINARY]);
const LISTABLE = new Set([...READABLE, '']); // directories have no extension

const CONTENT_TYPES = new Map([
  ['.md', 'text/markdown; charset=utf-8'], ['.markdown', 'text/markdown; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'], ['.log', 'text/plain; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'], ['.yaml', 'text/plain; charset=utf-8'],
  ['.yml', 'text/plain; charset=utf-8'], ['.csv', 'text/csv; charset=utf-8'],
  ['.tsv', 'text/tab-separated-values; charset=utf-8'], ['.xml', 'text/xml; charset=utf-8'],
  ['.ini', 'text/plain; charset=utf-8'], ['.conf', 'text/plain; charset=utf-8'],
  ['.toml', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.svg', 'image/svg+xml'],
  ['.bmp', 'image/bmp'], ['.ico', 'image/x-icon'],
  ['.avif', 'image/avif'], ['.jfif', 'image/jpeg'],
  ['.pdf', 'application/pdf'], ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.epub', 'application/epub+zip'],
  ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.ppt', 'application/vnd.ms-powerpoint'], ['.xls', 'application/vnd.ms-excel'], ['.doc', 'application/msword'],
  ['.html', 'text/html; charset=utf-8'], ['.htm', 'text/html; charset=utf-8'],
]);

const MAX_LIST = 2000;
const MAX_TEXT_BYTES = 24 * 1024 * 1024;
// save bodies carry baseContent AND content (each up to MAX_TEXT_BYTES after
// JSON escaping can ~2x), so the transport cap must exceed 2x that
const MAX_SAVE_BODY = 4 * MAX_TEXT_BYTES;
// container documents render fully in the client — cap them to bound memory
const MAX_DOC_BYTES = 100 * 1024 * 1024;
// served documents must never run script when navigated to directly from the
// address bar (same-origin context) — a blanket CSP closes that hole while
// leaving fetch-based consumption (arrayBuffer -> parse in the reader) intact
const DOC_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; script-src 'none'";

// ---------- text extraction engine ----------
// Shared by the `doc_reader` agent tool and the system-prompt context. Turns
// any supported document into plain UTF-8 text plus an outline, on the Host
// side (no browser involved). Cache is keyed by path + mtime + size.

function decodeTextHost(buf) {
	const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
	// strict UTF-8 first, then common CJK legacy encodings (full-ICU Node),
	// else lenient UTF-8. Mirrors the client's decodeText.
	for (const enc of ['utf-8', 'gbk', 'big5', 'shift_jis']) {
		try {
			const out = new TextDecoder(enc, enc === 'utf-8' ? { fatal: true, ignoreBOM: false } : {}).decode(bytes);
			if (typeof out === 'string') return out.replace(/^\uFEFF/u, '');
		} catch { /* try the next encoding */ }
	}
	return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/u, '');
}

/** Minimal zip reader (store + deflate). Good enough for epub/docx packages. */
function unzipEntries(buf) {
	if (!(buf instanceof Buffer)) buf = Buffer.from(buf);
	const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	let eocd = -1;
	for (let i = buf.byteLength - 22; i >= 0; i--) {
		if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
	}
	if (eocd < 0) throw new Error('not a zip archive');
	const count = view.getUint16(eocd + 10, true);
	let ptr = view.getUint32(eocd + 16, true);
	const out = new Map();
	for (let n = 0; n < count; n++) {
		if (ptr + 46 > buf.byteLength || view.getUint32(ptr, true) !== 0x02014b50) break;
		const method = view.getUint16(ptr + 10, true);
		const csize = view.getUint32(ptr + 20, true);
		const nameLen = view.getUint16(ptr + 28, true);
		const extraLen = view.getUint16(ptr + 30, true);
		const commentLen = view.getUint16(ptr + 32, true);
		const lho = view.getUint32(ptr + 42, true);
		const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
		if (view.getUint32(lho, true) === 0x04034b50) {
			const lNameLen = view.getUint16(lho + 26, true);
			const lExtraLen = view.getUint16(lho + 28, true);
			const start = lho + 30 + lNameLen + lExtraLen;
			const data = buf.subarray(start, start + csize);
			out.set(name, method === 0 ? Buffer.from(data) : inflateRawSync(data));
		}
		ptr += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

function decodeEntities(s) {
	return s
		.replace(/&#x([0-9a-f]+);/giu, (_, h) => { try { return String.fromCodePoint(Number.parseInt(h, 16)); } catch { return ''; } })
		.replace(/&#(\d+);/gu, (_, d) => { try { return String.fromCodePoint(Number.parseInt(d, 10)); } catch { return ''; } })
		.replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&quot;/gu, '"')
		.replace(/&apos;/gu, "'").replace(/&nbsp;/gu, ' ').replace(/&amp;/gu, '&');
}

function htmlToText(html) {
	const s = html
		.replace(/<script[\s\S]*?<\/script>/giu, ' ').replace(/<style[\s\S]*?<\/style>/giu, ' ')
		.replace(/<!--[\s\S]*?-->/gu, ' ')
		.replace(/<\/(p|div|section|article|header|footer|aside|h[1-6]|li|tr|blockquote|pre|table)>/giu, '\n')
		.replace(/<br\s*\/?>/giu, '\n')
		.replace(/<[^>]*>/gu, ' ');
	return decodeEntities(s).split('\n')
		.map((line) => line.replace(/[ \t\u00a0]+/gu, ' ').trim())
		.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function htmlOutline(html) {
	const outline = [];
	const re = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/giu;
	for (const m of html.matchAll(re)) {
		const text = htmlToText(m[2]);
		if (text) outline.push({ level: Number(m[1]), text });
	}
	return outline;
}

function markdownOutline(text) {
	const outline = [];
	let offset = 0;
	for (const line of String(text).split('\n')) {
		const m = /^(#{1,6})\s+(.*)$/u.exec(line);
		if (m && m[2].trim()) outline.push({ level: m[1].length, text: m[2].trim(), line: offset + 1 });
		offset += line.length + 1;
		if (outline.length >= 500) break;
	}
	return outline;
}

function epubExtract(bytes) {
	const entries = unzipEntries(bytes);
	const norm = new Map();
	for (const k of entries.keys()) norm.set(k.toLowerCase(), k);
	const get = (p) => { const k = norm.get(String(p).toLowerCase()); return k === undefined ? undefined : entries.get(k); };
	let opfPath = null;
	const container = get('META-INF/container.xml');
	if (container) opfPath = /<rootfile[^>]*full-path="([^"]+)"/iu.exec(container.toString('utf8'))?.[1] ?? null;
	const files = [];
	let base = '';
	if (opfPath && get(opfPath)) {
		base = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/') + 1) : '';
		const opf = get(opfPath).toString('utf8');
		const manifest = new Map();
		for (const m of opf.matchAll(/<item\s[^>]*>/giu)) {
			const id = /\bid="([^"]+)"/iu.exec(m[0])?.[1];
			const href = /\bhref="([^"]+)"/iu.exec(m[0])?.[1];
			if (id && href) manifest.set(id, href);
		}
		for (const m of opf.matchAll(/<itemref\s[^>]*idref="([^"]+)"/giu)) {
			const href = manifest.get(m[1]);
			if (href) { try { files.push(decodeURIComponent(href)); } catch { files.push(href); } }
		}
	}
	if (!files.length) files.push(...[...entries.keys()].filter((k) => /\.x?html?$/iu.test(k)).sort());
	const chapters = [];
	for (const href of files.slice(0, 500)) {
		const data = get(base + href) ?? get(href);
		if (!data) continue;
		const text = htmlToText(data.toString('utf8'));
		if (text) chapters.push(text);
	}
	// outline: EPUB2 toc.ncx navMap, else EPUB3 nav document
	const outline = [];
	const ncxKey = [...norm.keys()].find((k) => k.endsWith('.ncx'));
	if (ncxKey) {
		const ncx = entries.get(norm.get(ncxKey)).toString('utf8');
		for (const m of ncx.matchAll(/<navPoint[^>]*depth="(\d+)"[^>]*>[\s\S]*?<\/navPoint>/giu)) {
			const label = htmlToText(/<navLabel[^>]*>([\s\S]*?)<\/navLabel>/iu.exec(m[0])?.[1] ?? '');
			if (label) outline.push({ level: Math.max(1, Math.min(6, Number(m[1]) || 1)), text: label });
		}
		// depth attribute may sit on ancestors; fall back to flat navPoint order
		if (!outline.length) {
			for (const m of ncx.matchAll(/<navLabel[^>]*>([\s\S]*?)<\/navLabel>/giu)) {
				const label = htmlToText(m[1]);
				if (label) outline.push({ level: 1, text: label });
			}
		}
	} else {
		const navKey = [...norm.keys()].find((k) => /nav\.x?html?$/iu.test(k));
		if (navKey) {
			const nav = entries.get(norm.get(navKey)).toString('utf8');
			const toc = /epub:type="toc"[^>]*>([\s\S]*?)<\/nav>/iu.exec(nav)?.[1] ?? nav;
			for (const m of toc.matchAll(/<a\s[^>]*>([\s\S]*?)<\/a>/giu)) {
				const label = htmlToText(m[1]);
				if (label) outline.push({ level: 1, text: label });
			}
		}
	}
	return { text: chapters.join('\n\n'), outline };
}

function docxExtract(bytes) {
	const entries = unzipEntries(bytes);
	const doc = entries.get('word/document.xml');
	if (!doc) throw new Error('not a docx package (missing word/document.xml)');
	const xml = doc.toString('utf8');
	const lines = [];
	const outline = [];
	for (const para of xml.split(/<\/w:p>/iu)) {
		const style = /<w:pStyle\s[^>]*w:val="([^"]+)"/iu.exec(para)?.[1] ?? '';
		const headingLevel = /^heading([1-6])$/iu.exec(style)?.[1];
		const outlineLvl = /<w:outlineLvl\s[^>]*w:val="([0-5])"/iu.exec(para)?.[1];
		const level = headingLevel ?? (outlineLvl !== undefined ? String(Number(outlineLvl) + 1) : null);
		const text = decodeEntities(para
			.replace(/<w:tab[^>]*\/>/giu, '\t')
			.replace(/<w:br[^>]*\/>/giu, '\n')
			.replace(/<[^>]*>/gu, '')).trim();
		if (level !== null && text) outline.push({ level: Number(level), text });
		lines.push(text);
	}
	return { text: lines.join('\n').replace(/\n{3,}/gu, '\n\n').trim(), outline };
}

let pdfjsPromise = null;
function loadPdfjs() {
	pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').catch((error) => { pdfjsPromise = null; throw error; });
	return pdfjsPromise;
}

async function pdfExtract(bytes, maxPages = 800) {
	const pdfjs = await loadPdfjs();
	const doc = await pdfjs.getDocument({
		// pdfjs 4.x insists on a plain Uint8Array (not a Buffer view)
		data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, verbosity: 0,
	}).promise;
	const pages = Math.min(doc.numPages, maxPages);
	const parts = [];
	for (let i = 1; i <= pages; i++) {
		const page = await doc.getPage(i);
		const content = await page.getTextContent();
		parts.push(content.items.map((item) => item.str + (item.hasEOL ? '\n' : '')).join(''));
		page.cleanup?.();
	}
	let outline = [];
	try {
		const bookmarks = await doc.getOutline();
		const walk = (items, level) => {
			for (const it of items ?? []) {
				if (it.title) outline.push({ level: Math.min(6, level), text: it.title });
				walk(it.items ?? [], level + 1);
			}
		};
		walk(bookmarks, 1);
	} catch { /* bookmarks are optional */ }
	const text = parts.join('\n\n');
	return { text, outline: outline.slice(0, 200), truncated: doc.numPages > pages };
}

// ---------- office → PDF conversion (official libreoffice-kit) ----------
// The kit ships inside the DSH installation (Electron resolves it from the
// app archive); a plain-node test run finds neither and conversion reports
// unavailable instead of breaking the reader.
let kitState = 'idle'; // 'idle' | 'loading' | 'ready' | 'unavailable'
let kitPromise = null;
let kitConverter = null;
const convertInflight = new Map(); // cache pdf path -> Promise<pdfPath>

async function loadKit() {
	if (kitState === 'ready') return kitConverter;
	if (kitState === 'unavailable') throw new Error('文档转换引擎不可用(未找到 LibreOffice Kit)');
	if (kitPromise) return kitPromise;
	kitState = 'loading';
	kitPromise = (async () => {
		let mod = null;
		const roots = [];
		if (process.env.DSH_INSTALL_DIR) roots.push(join(dirname(process.env.DSH_INSTALL_DIR), 'libreoffice-kit', 'lib', 'index.js'));
		// Electron main process anchor: resourcesPath points at Contents/Resources
		// (DSH_INSTALL_DIR is a shell convenience and absent in the Host process)
		if (process.resourcesPath) roots.push(join(process.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js'));
		roots.push('@deepseek-ai/libreoffice-kit'); // plugin-local install fallback
		let lastError = '';
		let kitEntry = null;
		for (const spec of roots) {
			try {
				if (spec.startsWith('/')) {
					// Electron resolves CJS inside the app archive through require;
					// dynamic import of archive paths is unreliable — use createRequire
					const requireKit = createRequire(import.meta.url);
					mod = requireKit(spec);
					kitEntry = spec;
				} else {
					mod = await import(spec);
					try { kitEntry = import.meta.resolve ? import.meta.resolve(spec) : null; } catch { kitEntry = null; }
				}
				const api = mod?.createConverter ?? mod?.default?.createConverter;
				if (api) { mod = { createConverter: api }; break; }
				mod = null;
				kitEntry = null;
				lastError = 'no createConverter export';
			} catch (error) { lastError = `${error?.code ?? ''} ${error?.message ?? error}`.slice(0, 160); }
		}
		if (!mod?.createConverter || !kitEntry) throw new Error(`文档转换引擎不可用(未找到 LibreOffice Kit;${lastError})`);
		// Engine packages live inside the app archive but native executables only
		// run from the unpacked copy — the same resolver the official office-kit
		// passes (map the first .asar segment to .asar.unpacked).
		const fromKit = createRequire(kitEntry.startsWith('file:') ? new URL(kitEntry) : kitEntry);
		const resolveEnginePackage = (name) => {
			const manifest = fromKit.resolve(`${name}/package.json`);
			const hit = /^(.*?\.asar)([/\\].*)$/.exec(manifest);
			return hit ? `${hit[1]}.unpacked${hit[2]}` : manifest;
		};
		kitConverter = await mod.createConverter({ timeoutMs: 120_000, resolveEnginePackage });
		kitState = 'ready';
		return kitConverter;
	})();
	try {
		return await kitPromise;
	} catch (error) {
		kitState = 'unavailable';
		kitPromise = null;
		throw error;
	}
}

function convertCacheDir() {
	const dir = join(pluginDataDir(), 'convert');
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** Convert an office document to a cached PDF; returns the absolute pdf path. */
async function convertToPdf(file, info) {
	const { createHash } = await import('node:crypto');
	const key = createHash('sha1').update(`${file}:${info.mtimeMs}:${info.size}:v1`).digest('hex').slice(0, 24);
	const pdfPath = join(convertCacheDir(), `${key}.pdf`);
	if (await stat(pdfPath).then(() => true).catch(() => false)) return pdfPath;
	const running = convertInflight.get(pdfPath);
	if (running) return running;
	const job = (async () => {
		const converter = await loadKit();
		const { writeFile, rename: renameFile, unlink } = await import('node:fs/promises');
		const tmp = `${pdfPath}.tmp-${process.pid}-${Date.now()}`;
		try {
			// adversarial: a stuck converter process must not hang the request
			// forever (and pin the inflight entry). Env var is a test seam.
			const timeoutMs = Number(process.env.DOC_READER_CONVERT_TIMEOUT_MS) || 120_000;
			const result = await Promise.race([
				converter.render({ inputPath: file, outputPath: tmp }),
				new Promise((_, reject) => setTimeout(() => reject(new Error(`文档转换超时(${Math.round(timeoutMs / 1000)}s)`)), timeoutMs)),
			]);
			if (!result || typeof result !== 'object') throw new Error('转换结果无效');
			await renameFile(tmp, pdfPath);
			return pdfPath;
		} catch (error) {
			await unlink(tmp).catch(() => {});
			throw new Error(`文档转换失败:${error?.message ?? error}`);
		} finally {
			void pruneConvertCache();
		}
	})();
	convertInflight.set(pdfPath, job);
	try {
		return await job;
	} finally {
		convertInflight.delete(pdfPath);
	}
}

let pruneRunning = false;
async function pruneConvertCache() {
	if (pruneRunning) return;
	pruneRunning = true;
	try {
		const { readdir } = await import('node:fs/promises');
		const dir = convertCacheDir();
		const names = (await readdir(dir).catch(() => [])).filter((n) => n.endsWith('.pdf'));
		if (names.length <= 16) return;
		const entries = [];
		for (const name of names) {
			const info = await stat(join(dir, name)).catch(() => null);
			if (info) entries.push({ name, mtime: info.mtimeMs, size: info.size });
		}
		const total = entries.reduce((n, e) => n + e.size, 0);
		if (total <= 512 * 1024 * 1024) return;
		const { unlink } = await import('node:fs/promises');
		for (const e of entries.sort((a, b) => a.mtime - b.mtime).slice(0, Math.ceil(names.length / 4))) {
			await unlink(join(dir, e.name)).catch(() => {});
		}
	} finally {
		pruneRunning = false;
	}
}

const extractCache = new Map(); // absolute path -> { key, text, outline, format, bytes, note }
async function extractDocument(file, info, ext) {
	const key = `${info.mtimeMs}:${info.size}`;
	const hit = extractCache.get(file);
	if (hit && hit.key === key) return hit;
	const bytes = OFFICE.has(ext) ? null : await readFile(file);
	let out;
	let note = '';
	if (OFFICE.has(ext)) {
		// deck/spreadsheet: reuse the converted PDF, then extract its text layer
		const pdfPath = await convertToPdf(file, info);
		out = await pdfExtract(await readFile(pdfPath));
	}
	else if (ext === '.epub') out = epubExtract(bytes);
	else if (ext === '.docx') out = docxExtract(bytes);
	else if (ext === '.pdf') {
		out = await pdfExtract(bytes);
		if (out.truncated) note = `仅提取前 800 页(全书 ${'>'}${800} 页)`;
	}
	else if (ext === '.html' || ext === '.htm') {
		const html = decodeTextHost(bytes);
		out = { text: htmlToText(html), outline: htmlOutline(html) };
	} else {
		const text = decodeTextHost(bytes);
		out = { text, outline: markdownOutline(text) };
	}
	const value = { key, text: out.text ?? '', outline: out.outline ?? [], format: ext, bytes: info.size, note };
	if (extractCache.size >= 8) extractCache.delete(extractCache.keys().next().value);
	extractCache.set(file, value);
	return value;
}

function extensionOf(path) {
  const ext = extname(path).toLowerCase();
  return ext.startsWith('.') ? ext : `.${ext}`;
}

function fail(res, status, message, req) {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ error: message });
  // HEAD responses carry no body, so surface the error via a header for the
  // client probe path (open()/RecentList HEAD checks)
  const extra = req?.method === 'HEAD' ? { 'x-doc-reader-error': String(message).replace(/[^\x20-\x7e]/gu, '').slice(0, 200) } : {};
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...extra });
  res.end(body);
}

/** Same-host guard: reject cross-origin/DNS-rebinding requests (Host header must stay loopback). */
function hostAllowed(req) {
  const host = req.headers.host ?? '';
  const hostname = host.replace(/:\d+$/u, '').replace(/^\[/u, '').replace(/\]$/u).toLowerCase();
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]';
}

/**
 * Cross-site guard (CSRF): a malicious page in the browser can send requests
 * straight to 127.0.0.1 with a perfectly valid Host header, including
 * navigation-level `text/plain` form POSTs that bypass CORS entirely. Host
 * checks cannot see that; Sec-Fetch-Site / Origin can. Reject anything that
 * is provably cross-site; allow same-origin, same-none (address bar, Electron
 * internals) and legacy clients that send neither header.
 */
function requestAllowed(req) {
  const site = req.headers['sec-fetch-site'];
  if (site !== undefined && site !== 'same-origin' && site !== 'same-site' && site !== 'none') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    try {
      const { hostname } = new URL(origin);
      const h = (hostname ?? '').toLowerCase();
      if (h !== '127.0.0.1' && h !== 'localhost' && h !== '::1') return false;
    } catch {
      return false;
    }
  }
  return true;
}

export const inject = ['webServer', 'connection', 'tools', 'systemPrompt', 'commands'];

// ---------- plugin-owned configuration ----------
// Stored as plugin data (not a DSH Config row) so toggling a switch never
// restarts the plugin — the same pattern the weread plugin uses. Fields are
// validated on write; unknown keys are dropped.
const DEFAULT_CONFIG = {
	ctxInjectEnabled: true, // inject the active document's outline into the agent context
	ctxOutlineCount: 30, // max outline entries in that injection
	autoReloadEnabled: true, // push external file changes to the reader via SSE
	toolEnabled: true, // expose the doc_reader agent tool
	commandEnabled: true, // expose the /doc slash command
};
const CONFIG_FIELDS = {
	ctxInjectEnabled: 'boolean', ctxOutlineCount: 'number', autoReloadEnabled: 'boolean',
	toolEnabled: 'boolean', commandEnabled: 'boolean',
};

function pluginDataDir() {
	// DOC_READER_HOME is a test seam: the suite redirects writes away from $HOME
	return process.env.DOC_READER_HOME ?? join(homedir(), '.dsh', 'doc-reader');
}

function makeConfigStore() {
	const dir = pluginDataDir();
	const file = join(dir, 'config.json');
	let current = { ...DEFAULT_CONFIG };
	try {
		const raw = JSON.parse(readFileSync(file, 'utf8'));
		if (raw && typeof raw === 'object') {
			for (const key of Object.keys(CONFIG_FIELDS)) {
				const value = raw[key];
				const want = CONFIG_FIELDS[key];
				if (want === 'boolean' && typeof value === 'boolean') current[key] = value;
				if (want === 'number' && typeof value === 'number' && Number.isFinite(value)) current[key] = value;
			}
		}
	} catch { /* no config yet — defaults */ }
	const save = async () => {
		try {
			mkdirSync(dir, { recursive: true });
			const tmp = join(dir, `.config.json.tmp-${process.pid}`);
			writeFileSync(tmp, JSON.stringify(current, null, '\t'), 'utf8');
			renameSync(tmp, file);
		} catch { /* read-only home: config stays in memory */ }
	};
	return {
		get: () => current,
		update(patch) {
			const next = { ...current };
			for (const [key, value] of Object.entries(patch ?? {})) {
				if (!(key in CONFIG_FIELDS)) continue;
				const want = CONFIG_FIELDS[key];
				if (want === 'boolean' && typeof value === 'boolean') next[key] = value;
				else if (want === 'number' && typeof value === 'number' && Number.isFinite(value)) next[key] = Math.max(1, Math.min(100, Math.round(value)));
			}
			current = next;
			void save();
			return { ...current };
		},
	};
}

/** Runtime shared by HTTP endpoints, the agent tool and the slash command. */
function makeRuntime(config) {
	const state = {
		active: null, // { path, at } — the document currently open in the reader
		recent: [], // [{ path, at }] capped, persisted alongside the config
	};
	const recentFile = join(pluginDataDir(), 'recent.json');
	try {
		const raw = JSON.parse(readFileSync(recentFile, 'utf8'));
		if (Array.isArray(raw)) {
			state.recent = raw.filter((e) => e && typeof e.path === 'string').slice(0, 20);
		}
	} catch { /* start empty */ }
	const persistRecent = () => {
		try {
			mkdirSync(dirname(recentFile), { recursive: true });
			const tmp = join(dirname(recentFile), `.recent.json.tmp-${process.pid}`);
			writeFileSync(tmp, JSON.stringify(state.recent), 'utf8');
			renameSync(tmp, recentFile);
		} catch { /* best effort */ }
	};
	const setActive = (path) => {
		state.active = { path, at: Date.now() };
		state.recent = [{ path, at: state.active.at }, ...state.recent.filter((e) => e.path !== path)].slice(0, 20);
		persistRecent();
		ctxCache = { at: 0, path: null, text: '' }; // invalidate the prompt context
	};

	// ---------- SSE event stream ----------
	const sseClients = new Set(); // { res, watchPath }
	const watchStore = new Map(); // path -> { refs, watcher, last, timer }
	const statKey = async (path) => {
		const info = await lstat(path).catch(() => null);
		return info && info.isFile() ? `${info.mtimeMs}:${info.size}` : null;
	};
	const ensureWatch = (path) => {
		const existing = watchStore.get(path);
		if (existing) { existing.refs += 1; return; }
		const entry = { refs: 1, watcher: null, last: null, timer: null };
		watchStore.set(path, entry);
		const check = async () => {
			entry.timer = null;
			const key = await statKey(path);
			if (key === null || key === entry.last) return;
			entry.last = key;
			broadcast({ type: 'change', path });
		};
		const attach = async () => {
			entry.last = await statKey(path);
			try {
				// watch the parent directory: atomic save (temp + rename) swaps
				// the directory entry, which would invalidate a file-level watch
				entry.watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
					if (typeof filename === 'string' && filename !== basename(path)) return;
					if (entry.timer) clearTimeout(entry.timer);
					entry.timer = setTimeout(() => { void check(); }, 120);
				});
				entry.watcher.on('error', () => { /* transient (rename swap): re-attach lazily */ });
			} catch { /* unwatchable fs — events simply never fire */ }
		};
		void attach();
	};
	const releaseWatch = (path) => {
		const entry = watchStore.get(path);
		if (!entry) return;
		entry.refs -= 1;
		if (entry.refs > 0) return;
		watchStore.delete(path);
		if (entry.timer) clearTimeout(entry.timer);
		try { entry.watcher?.close(); } catch { /* already closed */ }
	};
	/** Re-baseline a watched file after this plugin itself saved it (no echo event). */
	const touchWatch = (path) => {
		const entry = watchStore.get(path);
		if (!entry) return;
		void statKey(path).then((key) => { if (key !== null) entry.last = key; });
	};
	const broadcast = (event) => {
		if (!sseClients.size) return;
		const frame = `data: ${JSON.stringify(event)}\n\n`;
		for (const client of sseClients) {
			try { client.res.write(frame); } catch { /* drop on next close event */ }
		}
	};

	// ---------- system-prompt context ----------
	let ctxCache = { at: 0, path: null, text: '' };
	let ctxBuilding = false;
	const rebuildCtx = async () => {
		if (ctxBuilding) return;
		ctxBuilding = true;
		try {
			const cfg = config.get();
			let text = '';
			if (cfg.ctxInjectEnabled && state.active) {
				const path = state.active.path;
				try {
					const info = await lstat(path).catch(() => null);
					if (info && info.isFile()) {
						const doc = await extractDocument(path, info, extensionOf(path)).catch(() => null);
						if (doc) {
							const count = Math.max(1, Math.min(100, cfg.ctxOutlineCount));
							const outline = doc.outline.slice(0, count)
								.map((item) => `${'  '.repeat(Math.max(0, item.level - 1))}- ${item.text}`)
								.join('\n');
							text = `用户当前在文档阅读器打开(供对话参考;用户未提及时不必主动展开):\n${path}(${doc.format.slice(1)} 文档,${formatBytes(doc.bytes)})`
								+ (outline ? `\n大纲:\n${outline}` : '');
						}
					}
				} catch { /* unreadable: inject nothing */ }
			}
			ctxCache = { at: Date.now(), path: state.active?.path ?? null, text };
		} finally { ctxBuilding = false; }
	};
	const contextText = () => {
		if (!state.active) return '';
		if (ctxCache.path === state.active.path && Date.now() - ctxCache.at < 10 * 60_000) return ctxCache.text;
		if (ctxCache.path !== state.active.path) ctxCache = { at: 0, path: null, text: '' };
		void rebuildCtx();
		return ctxCache.text;
	};

	const updateConfig = (patch) => {
		const result = config.update(patch);
		ctxCache = { at: 0, path: null, text: '' }; // context flags may have flipped
		return result;
	};

	return { config, updateConfig, state, setActive, sseClients, ensureWatch, releaseWatch, touchWatch, broadcast, contextText };
}

function formatBytes(n) {
	if (!Number.isFinite(n)) return '';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Resolve + validate a readable document path shared by routes, tool and command. */
async function resolveReadable(target) {
	const file = normalize(String(target ?? ''));
	if (!isAbsolute(file)) return { error: '需要绝对路径' };
	const ext = extensionOf(file);
	if (!READABLE.has(ext)) return { error: `不支持的扩展名:${ext || '(无)'}` };
	const info = await lstat(file).catch(() => null);
	if (!info) return { error: '文件不存在' };
	if (info.isSymbolicLink()) return { error: '符号链接不可读' };
	if (!info.isFile()) return { error: '不是普通文件' };
	if (TEXTUAL.has(ext) && info.size > MAX_TEXT_BYTES) return { error: '文本文件过大(>24MB)' };
	if ((ext === '.html' || ext === '.htm' || ext === '.epub') && info.size > MAX_DOC_BYTES) return { error: '文档过大(>100MB)' };
	if (OFFICE.has(ext) && info.size > MAX_DOC_BYTES) return { error: '文档过大(>100MB)' };
	if (info.size > 2 * MAX_DOC_BYTES) return { error: '文件过大' };
	return { file, ext, info };
}

export function apply(ctx) {
	const config = makeConfigStore();
	const runtime = makeRuntime(config);
	pluginRuntime = runtime; // test seam: tools/commands reach the live instance

	ctx.effect(() => ctx.webServer.register({
		kind: 'prefix',
		path: ROUTE,
		handler: (req, res) => {
			handleRequest(ctx, req, res, runtime).catch((error) => {
				ctx.logger.warn(`doc-reader route error: ${error?.message ?? error}`);
				if (!res.headersSent) fail(res, 500, 'internal error');
				else res.destroy();
			});
		},
	}), 'dsh-doc-reader: file routes');

	// SSE heartbeat: keeps proxies from idling the stream out and lets dead
	// connections surface via the close event.
	const heartbeat = setInterval(() => {
		for (const client of runtime.sseClients) {
			try { client.res.write(':hb\n\n'); } catch { /* cleaned up on close */ }
		}
	}, 25_000);
	heartbeat.unref?.();
	ctx.effect(() => () => clearInterval(heartbeat), 'dsh-doc-reader: sse heartbeat');

	// ---------- agent tool: read / outline / search any local document ----------
	ctx.effect(() => ctx.tools.register({
		name: 'doc_reader',
		description: '读取本地文档:提取纯文本(read,分段+offset 续读)、标题大纲(outline)、单篇全文搜索(search)、跨最近打开的文档检索(search_docs)。支持 md/txt/log/json/yaml/csv/tsv/xml/ini/toml/html/epub/docx/pdf;回答涉及本地文档内容的问题时调用。',
		parameters: {
			type: 'object',
			properties: {
				action: { type: 'string', enum: ['read', 'outline', 'search', 'search_docs'], description: 'read=读取单篇文本;outline=单篇大纲;search=单篇搜索;search_docs=跨最近文档搜索(无需 path)' },
				path: { type: 'string', description: '文档的绝对路径(search_docs 不需要)' },
				offset: { type: 'number', description: 'read:起始字符偏移(默认 0,续读传上次返回的 offset)' },
				limit: { type: 'number', description: 'read:最多返回字符数(默认 16000,上限 60000)' },
				query: { type: 'string', description: 'search/search_docs:关键词(大小写不敏感)' },
				maxMatches: { type: 'number', description: 'search:最多命中条数(默认 20,上限 50)' },
				contextLines: { type: 'number', description: 'search:每条命中带几行上下文(默认 1,上限 3)' },
			},
			required: ['action'],
		},
		output: textOutput,
		async execute(args) {
			try {
				return await runToolAction(runtime, args);
			} catch (error) {
				return `执行失败:${error?.message ?? error}`;
			}
		},
	}), 'dsh-doc-reader: agent tool');

	// ---------- system-prompt context: what the user is reading ----------
	try {
		ctx.effect(() => ctx.systemPrompt.context({
			name: 'doc-reader:active',
			order: 225, // just after weread's reading context (220)
			text: () => runtime.contextText(),
		}), 'dsh-doc-reader: prompt context');
	} catch (error) {
		ctx.logger.warn(`doc-reader systemPrompt registration failed: ${error?.message ?? error}`);
	}

	// ---------- human slash command: /doc ----------
	try {
		ctx.effect(() => ctx.commands.register({
			name: 'doc',
			description: '文档阅读器:打开最近文档(/doc 关键词);无参数列出最近 5 个',
			input: { hint: '关键词(留空列出最近 5 个)' },
			async handler(arg) {
				if (!config.get().commandEnabled) return { kind: 'error', text: '命令已在插件配置中停用。' };
				const q = typeof arg === 'string' ? arg : String(arg?.rawInput ?? '').trim();
				if (!runtime.state.recent.length) {
					return { kind: 'error', text: '最近文档为空:先在文档阅读器面板打开一个文件。' };
				}
				if (!q) {
					const list = runtime.state.recent.slice(0, 5).map((e, i) => `${i + 1}. ${basename(e.path)}\n   ${e.path}`).join('\n');
					return { kind: 'success', text: `最近文档:\n${list}\n输入 /doc 名称 打开。` };
				}
				const lower = q.toLowerCase();
				const hit = runtime.state.recent.find((e) => basename(e.path).toLowerCase().includes(lower))
					?? runtime.state.recent.find((e) => e.path.toLowerCase().includes(lower));
				if (!hit) {
					const names = runtime.state.recent.slice(0, 5).map((e) => basename(e.path)).join('、');
					return { kind: 'error', text: `最近文档中没有匹配「${q}」的条目。最近:${names}` };
				}
				runtime.broadcast({ type: 'open', path: hit.path });
				return { kind: 'success', text: `已在文档阅读器打开:${hit.path}` };
			},
		}), 'dsh-doc-reader: /doc command');
	} catch (error) {
		ctx.logger.warn(`doc-reader command registration failed: ${error?.message ?? error}`);
	}
}

const textOutput = {
	schema: { type: 'string' },
	render: (_args, value) => [{ type: 'text', text: String(value) }],
};

let pluginRuntime = null; // set by apply(); test seam for captured registrations

/**
 * Cross-document search over the documents the reader has opened recently
 * (plus the active one). Extraction reuses the cached engine, so this stays
 * cheap after the first read of each file.
 */
async function searchRecentDocs(runtime, args) {
	const query = String(args?.query ?? '').trim();
	if (!query) return 'search_docs 需要非空 query。';
	const lower = query.toLowerCase();
	const paths = [...new Set([
		runtime.state.active?.path,
		...runtime.state.recent.map((e) => e.path),
	].filter((p) => typeof p === 'string'))].slice(0, 12);
	const groups = [];
	let scanned = 0;
	for (const path of paths) {
		if (groups.length >= 8) break;
		const resolved = await resolveReadable(path);
		if (resolved.error) continue;
		let doc;
		try { doc = await extractDocument(resolved.file, resolved.info, resolved.ext); } catch { continue; }
		scanned += 1;
		const lines = doc.text.split('\n');
		const hits = [];
		for (let i = 0; i < lines.length && hits.length < 6; i++) {
			if (lines[i].toLowerCase().includes(lower)) hits.push(i);
		}
		if (hits.length) groups.push({ file: resolved.file, lines, hits, format: doc.format.slice(1), bytes: doc.bytes });
	}
	if (!groups.length) return `在 ${scanned} 篇最近文档中搜索「${query}」:0 命中。`;
	const body = groups.map((g) => {
		const head = `${g.file}(${g.format},${formatBytes(g.bytes)})`;
		const rows = g.hits.map((i) => `>>[L${i + 1}] ${g.lines[i]}`).join('\n');
		return `${head}\n${rows}`;
	}).join('\n---\n');
	return `跨最近文档搜索「${query}」:${groups.length}/${scanned} 篇命中(每篇最多 6 条):\n${body}`;
}

async function runToolAction(runtime, args) {
	const cfg = runtime.config.get();
	if (!cfg.toolEnabled) return 'doc_reader 工具已在插件配置中停用。';
	const action = args?.action;
	if (!['read', 'outline', 'search', 'search_docs'].includes(action)) return 'action 必须是 read / outline / search / search_docs。';
	if (action === 'search_docs') return searchRecentDocs(runtime, args);
	const resolved = await resolveReadable(args?.path);
	if (resolved.error) return `无法读取:${resolved.error}(${args?.path ?? ''})`;
	const doc = await extractDocument(resolved.file, resolved.info, resolved.ext);
	const head = `${resolved.file}(${doc.format.slice(1)},${formatBytes(doc.bytes)}${doc.note ? `,${doc.note}` : ''})`;
	if (action === 'outline') {
		if (!doc.outline.length) return `${head}\n没有可用大纲(md 依赖 # 标题;epub 依赖目录;docx 依赖标题样式;pdf 依赖书签)。可用 read 阅读全文。`;
		const cap = doc.outline.length > 100;
		const lines = doc.outline.slice(0, 100)
			.map((item) => `${'  '.repeat(Math.max(0, item.level - 1))}- ${item.text}${item.line ? `(L${item.line})` : ''}`)
			.join('\n');
		return `${head}\n大纲(共 ${doc.outline.length} 条${cap ? ',仅显示前 100' : ''}):\n${lines}`;
	}
	if (action === 'search') {
		const query = String(args?.query ?? '').trim();
		if (!query) return 'search 需要非空 query。';
		const maxMatches = Math.max(1, Math.min(50, Math.round(Number(args?.maxMatches) || 20)));
		const contextLines = Math.max(0, Math.min(3, Math.round(Number(args?.contextLines ?? 1))));
		const lines = doc.text.split('\n');
		const lower = query.toLowerCase();
		const hits = [];
		for (let i = 0; i < lines.length && hits.length < maxMatches; i++) {
			if (lines[i].toLowerCase().includes(lower)) hits.push(i);
		}
		const total = hits.length === maxMatches
			? lines.reduce((n, line, i) => n + (i > hits[hits.length - 1] && line.toLowerCase().includes(lower) ? 1 : 0), maxMatches)
			: hits.length;
		if (!hits.length) return `${head}\n搜索「${query}」:0 条命中。`;
		const shown = hits.map((i) => {
			const from = Math.max(0, i - contextLines);
			const to = Math.min(lines.length - 1, i + contextLines);
			const block = [];
			for (let j = from; j <= to; j++) block.push(`${j === i ? '>>' : '  '}[L${j + 1}] ${lines[j]}`);
			return block.join('\n');
		}).join('\n---\n');
		return `${head}\n搜索「${query}」:${total} 条命中(显示前 ${hits.length}):\n${shown}`;
	}
	// read
	const offset = Math.max(0, Math.round(Number(args?.offset) || 0));
	const limit = Math.max(1, Math.min(60_000, Math.round(Number(args?.limit) || 16_000)));
	const text = doc.text;
	if (!text.trim()) return `${head}\n文档没有可提取的文本(可能是纯图片 PDF/空文件)。`;
	if (offset >= text.length) return `${head}\noffset=${offset} 超出全文长度 ${text.length}。`;
	const slice = text.slice(offset, offset + limit);
	const rest = text.length - offset - slice.length;
	return `${head}(全文 ${text.length} 字符)\n—— 内容 [${offset}, ${offset + slice.length}) ——\n${slice}`
		+ (rest > 0 ? `\n—— 未完:剩余 ${rest} 字符,传 offset=${offset + slice.length} 继续 ——` : '\n—— 已到文末 ——');
}

async function handleRequest(ctx, req, res, runtime) {
  // Route admission, in order of authority:
  // 1. the Host connection service's own fence + signed browser-credential
  //    check (`ctx.connection.requestRejection`) — authoritative when present;
  //    do NOT additionally fall back to Host/Origin checks (the connection
  //    service already applies them and knows the live Peer).
  // 2. loopback Host + cross-site Origin/Sec-Fetch-Site fence — only when the
  //    connection service is unavailable (e.g. the standalone test harness).
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
  if (connection && typeof connection.requestRejection === 'function') {
    const rejection = connection.requestRejection({ headers: req.headers });
    if (rejection) return fail(res, rejection, 'forbidden', req);
  } else if (!hostAllowed(req) || !requestAllowed(req)) {
    return fail(res, 403, 'forbidden', req);
  }
  const url = new URL(req.url, 'http://dsh.invalid');
  const tail = url.pathname.slice(ROUTE.length); // "/list" | "/file/<encoded>" | "/rename" | "/reveal" | ...
  const kind = tail.replace(/^\//u, '').split('/')[0];
  // config is read-write (GET reads, POST updates); handleConfig splits itself
  const write = kind === 'rename' || kind === 'save' || kind === 'active' || kind === 'translate';
  if (!write && kind !== 'config' && req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    return res.end();
  }
  if (write && req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' });
    return res.end();
  }
  if (kind === 'list') return handleList(ctx, req, res, url);
  if (kind === 'file') return handleFile(ctx, req, res, url);
  if (kind === 'rename') return handleRename(ctx, req, res, runtime);
  if (kind === 'save') return handleSave(ctx, req, res, runtime);
  if (kind === 'reveal') return handleReveal(ctx, req, res, url);
  if (kind === 'config') return handleConfig(ctx, req, res, runtime);
  if (kind === 'active') return handleActive(ctx, req, res, runtime);
  if (kind === 'convert') return handleConvert(ctx, req, res, url);
  if (kind === 'translate') return handleTranslate(ctx, req, res);
  if (kind === 'translate-models') {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); return res.end(); }
    const catalog = await llmCatalog(ctx);
    const payload = JSON.stringify(catalog);
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(payload);
  }
  if (kind === 'events') return handleEvents(ctx, req, res, url, runtime);
  return fail(res, 404, 'not found');
}

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * POST /save { path, baseContent, content } — save an edited textual document.
 * Three-way conflict check like the VSCode extension: if the file on disk
 * differs from BOTH the base the editor started from and the new content,
 * someone else changed it and the caller must reload (409).
 */
async function handleSave(ctx, req, res, runtime) {
  let body;
  try {
    body = await readJsonBody(req, MAX_SAVE_BODY);
  } catch {
    return fail(res, 400, 'invalid JSON body');
  }
  const { path: target, baseContent, content } = body ?? {};
  if (typeof target !== 'string' || typeof content !== 'string' || typeof baseContent !== 'string') {
    return fail(res, 400, 'path, baseContent and content required');
  }
  if (content.includes('\0')) return fail(res, 400, 'invalid content');
  if (Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES) return fail(res, 413, 'content too large');
  const file = normalize(target);
  if (!isAbsolute(file)) return fail(res, 400, 'absolute path required');
  const ext = extensionOf(file);
  if (!TEXTUAL.has(ext)) return fail(res, 403, 'only textual files are editable');
  const { lstat, readFile, writeFile, rename } = await import('node:fs/promises');
  const { basename, dirname } = await import('node:path');
  // lstat: never follow a symlinked file (read or write) — the extension
  // whitelist must apply to the real file, and writing must not punch through
  // a link to an arbitrary target.
  const info = await lstat(file).catch(() => null);
  if (!info) return fail(res, 404, 'file not found');
  if (info.isSymbolicLink()) return fail(res, 403, 'symbolic links are not editable');
  if (!info.isFile()) return fail(res, 400, 'path is not a file');
  if (info.size > MAX_TEXT_BYTES) return fail(res, 413, 'file too large');
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === null) return fail(res, 404, 'file not found');
  if (current !== baseContent && current !== content) {
    return fail(res, 409, 'file changed on disk — reopen it first');
  }
  if (current === content) {
    const payload = JSON.stringify({ ok: true, unchanged: true });
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(payload);
  }
  // atomic write: temp file in the same directory + rename. A crash or race
  // can never leave a truncated document behind, and rename replaces the
  // path itself rather than following it.
  const tmp = join(dirname(file), `.${basename(file)}.dsh-save-${process.pid}-${Date.now()}`);
  await writeFile(tmp, content, 'utf8');
  const { chmod } = await import('node:fs/promises');
  await chmod(tmp, info.mode).catch(() => {}); // keep original permissions (0600 notes must not become 0644)
  await rename(tmp, file);
  runtime?.touchWatch(file); // our own save must not echo back as an external change
  const payload = JSON.stringify({ ok: true });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/**
 * POST /rename { path, name } — rename a readable file within its directory,
 * keeping the extension. Mirrors the VSCode extension's rename semantics:
 * stem-only input (extension auto-stripped when retyped), no separators,
 * target extension must stay in the whitelist, no overwrite.
 */
async function handleRename(ctx, req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return fail(res, 400, 'invalid JSON body');
  }
  const { path: from, name } = body ?? {};
  if (typeof from !== 'string' || typeof name !== 'string') return fail(res, 400, 'path and name required');
  if (name.includes('\0')) return fail(res, 400, 'invalid name');
  const target = normalize(from);
  if (!isAbsolute(target)) return fail(res, 400, 'absolute path required');
  const ext = extensionOf(target);
  if (!READABLE.has(ext)) return fail(res, 403, 'unsupported file type');
  // strip the extension when the user retyped it
  let stem = name.trim();
  if (ext && stem.toLowerCase().endsWith(ext)) stem = stem.slice(0, -ext.length).trim();
  if (!stem) return fail(res, 400, 'name required');
  if (stem === '.' || stem === '..' || stem.includes('/') || stem.includes('\\')) return fail(res, 400, 'invalid name');
  const { basename, dirname } = await import('node:path');
  if (basename(stem) !== stem) return fail(res, 400, 'invalid name');
  if (Buffer.byteLength(`${stem}${ext}`, 'utf8') > 255) return fail(res, 400, 'name too long');
  const fromName = basename(target);
  const currentStem = ext && fromName.toLowerCase().endsWith(ext) ? fromName.slice(0, -ext.length) : fromName;
  if (stem === currentStem) return fail(res, 400, 'unchanged');
  const to = join(dirname(target), `${stem}${ext}`);
  const { lstat, link, unlink, rename, access } = await import('node:fs/promises');
  const info = await lstat(target).catch(() => null);
  if (!info) return fail(res, 404, 'file not found');
  if (info.isSymbolicLink()) return fail(res, 403, 'symbolic links are not editable');
  if (!info.isFile()) return fail(res, 400, 'path is not a file');
  // case-only rename on a case-insensitive volume needs a two-step hop
  // (link/EEXIST cannot distinguish "same file, different case" there)
  const caseOnly = (process.platform === 'darwin' || process.platform === 'win32') && to !== target && to.toLowerCase() === target.toLowerCase();
  if (caseOnly) {
    const hop = join(dirname(target), `.dsh-rename-${process.pid}-${Date.now()}${ext}`);
    await rename(target, hop);
    await rename(hop, to).catch(async (error) => { await rename(hop, target).catch(() => {}); throw error; });
  } else if (process.platform === 'win32') {
    try { await access(to); return fail(res, 409, 'target exists'); } catch { /* good: not exists */ }
    await rename(target, to);
  } else {
    // hardlink+unlink: kernel-atomic no-clobber rename (link() fails with
    // EEXIST if the target appeared, closing the access/rename TOCTOU gap)
    try {
      await link(target, to);
    } catch (error) {
      if (error?.code === 'EEXIST') return fail(res, 409, 'target exists');
      throw error;
    }
    await unlink(target).catch(async (error) => { await unlink(to).catch(() => {}); throw error; });
  }
  const payload = JSON.stringify({ ok: true, path: to });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** GET /reveal?path=<encoded> — reveal a file or its parent directory in the OS file manager. */
async function handleReveal(ctx, req, res, url) {
  const raw = url.searchParams.get('path'); // already percent-decoded by URLSearchParams
  const target = normalize(raw ?? '');
  if (!target) return fail(res, 400, 'path required');
  if (!isAbsolute(target)) return fail(res, 400, 'absolute path required');
  const info = await stat(target).catch(() => undefined);
  if (!info) return fail(res, 404, 'path not found', req);
  const { spawn } = await import('node:child_process');
  // Always reveal, never launch: bare `open <dir>` would *execute* bundle
  // directories such as Foo.app. `open -R` selects in the parent window for
  // files and directories alike; explorer /select, does the same on Windows.
  // Linux has no universal "select in file manager" verb — open the parent
  // directory with xdg-open as the closest safe approximation.
  const child = process.platform === 'win32'
    ? spawn('explorer', [`/select,${target}`], { stdio: 'ignore' })
    : process.platform === 'darwin'
      ? spawn('open', ['-R', target], { stdio: 'ignore' })
      : spawn('xdg-open', [dirname(target)], { stdio: 'ignore' });
  child.on('spawn', () => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
  });
  child.on('error', (error) => fail(res, 500, `reveal failed: ${error.message}`));
}

async function handleList(ctx, req, res, url) {
  const raw = url.searchParams.get('path'); // already percent-decoded by URLSearchParams
  const dir = raw === null || raw === '' ? (await import('node:os')).homedir() : normalize(raw);
  if (!isAbsolute(dir)) return fail(res, 400, 'absolute path required');
  const info = await stat(dir).catch(() => undefined);
  if (!info) return fail(res, 404, 'directory not found');
  if (!info.isDirectory()) return fail(res, 400, 'path is not a directory');
  const { readdir } = await import('node:fs/promises');
  const showHidden = url.searchParams.get('hidden') === '1';
  const all = await readdir(dir).catch(() => null);
  if (all === null) return fail(res, 403, 'cannot read directory');
  const names = all.filter((name) => showHidden || !name.startsWith('.'));
  const truncated = names.length > MAX_LIST;
  const entries = [];
  for (const name of names.slice(0, MAX_LIST)) {
    let childInfo;
    try {
      childInfo = await lstat(join(dir, name));
    } catch {
      continue; // broken symlink or racing deletion
    }
    if (childInfo.isSymbolicLink()) continue; // whitelist must apply to real files only
    const isDir = childInfo.isDirectory();
    const ext = isDir ? '' : extensionOf(name);
    if (!LISTABLE.has(ext)) continue;
    entries.push({ name, path: join(dir, name), directory: isDir, size: isDir ? null : childInfo.size });
  }
  entries.sort((a, b) => (b.directory - a.directory) || a.name.localeCompare(b.name));
  const body = JSON.stringify({ path: dir, entries, truncated });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function handleFile(ctx, req, res, url) {
  const encoded = url.pathname.slice(ROUTE.length + '/file/'.length);
  let target;
  try {
    target = normalize(decodeURIComponent(encoded));
  } catch {
    return fail(res, 400, 'bad path encoding');
  }
  if (!isAbsolute(target)) return fail(res, 400, 'absolute path required');
  const ext = extensionOf(target);
  if (!READABLE.has(ext)) return fail(res, 403, `unsupported extension: ${ext || '(none)'}`);
  // lstat: the extension whitelist must apply to the file itself — a symlink
  // named notes.md pointing at ~/.ssh/id_ed25519 must not be readable.
  const info = await lstat(target).catch(() => undefined);
  if (!info) return fail(res, 404, 'file not found');
  if (info.isSymbolicLink()) return fail(res, 403, 'symbolic links are not readable');
  if (!info.isFile()) return fail(res, 400, 'path is not a file');
  if (TEXTUAL.has(ext) && info.size > MAX_TEXT_BYTES) return fail(res, 413, 'text file too large');
  if ((ext === '.html' || ext === '.htm' || ext === '.epub') && info.size > MAX_DOC_BYTES) return fail(res, 413, 'document too large');
  const type = CONTENT_TYPES.get(ext) ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': DOC_CSP,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

/** GET/POST /config — plugin-owned settings edited from the plugin row config UI. */
async function handleConfig(ctx, req, res, runtime) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    const body = JSON.stringify(runtime.config.get());
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(body);
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return fail(res, 400, 'invalid JSON body');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(res, 400, 'object body required');
  const updated = runtime.updateConfig(body);
  const payload = JSON.stringify(updated);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

/** POST /active { path } — the reader reports the document it just opened. */
async function handleActive(ctx, req, res, runtime) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return fail(res, 400, 'invalid JSON body');
  }
  const resolved = await resolveReadable(body?.path);
  if (resolved.error) return fail(res, 400, resolved.error);
  runtime.setActive(resolved.file);
  const payload = JSON.stringify({ ok: true, active: resolved.file, recent: runtime.state.recent.length });
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

/**
 * GET /events[?path=<encoded>] — Server-Sent Events stream.
 * Every client receives global {type:'open'} broadcasts (slash command); a
 * client that names a path also receives {type:'change'} when that file
 * changes on disk (external edit), suppressed for this plugin's own saves.
 */
/** Split text for translation on paragraph boundaries, hard-cut as a fallback. */
function splitForTranslate(text, max) {
	if (text.length <= max) return [text];
	const paragraphs = String(text).split(/\n{2,}/u);
	const chunks = [];
	let current = '';
	for (const para of paragraphs) {
		const candidate = current ? `${current}\n\n${para}` : para;
		if (candidate.length <= max) { current = candidate; continue; }
		if (current) { chunks.push(current); current = ''; }
		if (para.length <= max) { current = para; continue; }
		for (let i = 0; i < para.length; i += max) chunks.push(para.slice(i, i + max));
	}
	if (current) chunks.push(current);
	return chunks.length ? chunks : [''];
}

/** Discover the DSH LLM provider/model catalog for the translate settings. */
let llmCatalogCache = { at: 0, value: null };
async function llmCatalog(ctx) {
	if (llmCatalogCache.value && Date.now() - llmCatalogCache.at < 60_000) return llmCatalogCache.value;
	let providers = [];
	const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
	if (llm && typeof llm.listProviders === 'function') {
		try {
			const names = await llm.listProviders();
			providers = await Promise.all((Array.isArray(names) ? names : []).map(async (entry) => {
				const name = typeof entry === 'string' ? entry : entry?.name ?? entry?.id;
				if (!name) return null;
				let models = [];
				try {
					if (typeof llm.listModels === 'function') {
						const listed = await llm.listModels(name);
						models = (Array.isArray(listed) ? listed : [])
							.map((m) => (typeof m === 'string' ? m : m?.id ?? m?.model))
							.filter((m) => typeof m === 'string' && m);
					}
				} catch { /* catalog is optional */ }
				return { name, models };
			}));
			providers = providers.filter(Boolean);
		} catch { /* no providers */ }
	}
	llmCatalogCache = { at: Date.now(), value: { providers } };
	return llmCatalogCache.value;
}

/** Anonymous Google translate_a/single endpoint (the "gtx" web client).
 * Any compatible reverse proxy base URL can be supplied by the user. */
const GOOGLE_TL = { 'zh-Hans': 'zh-CN', 'zh-Hant': 'zh-TW' };
async function translateWithGoogle(text, targetLanguage, endpoint) {
	const base = (endpoint || 'https://translate.googleapis.com').replace(/\/+$/u, '');
	const tl = GOOGLE_TL[targetLanguage] || targetLanguage;
	// keep the whole request URL comfortably below transport limits
	const chunks = splitForTranslate(text, 1200);
	const parts = [];
	for (const chunk of chunks) {
		const url = `${base}/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(tl)}&dt=t&q=${encodeURIComponent(chunk)}`;
		const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
		if (!res.ok) throw new Error(`Google 端点返回 ${res.status}`);
		const data = await res.json().catch(() => null);
		const segments = Array.isArray(data?.[0]) ? data[0] : null;
		if (!segments) throw new Error('Google 端点返回了无法解析的内容');
		const out = segments.map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
		if (!out.trim()) throw new Error('Google 端点未返回译文');
		parts.push(out);
	}
	return parts.join('\n\n');
}

/** Translate through the configured DSH model (ctx.llm.stream). */
async function translateWithLlm(ctx, text, targetLanguage, provider, model) {
	const llm = typeof ctx.get === 'function' ? ctx.get('llm') : undefined;
	if (!llm || typeof llm.stream !== 'function') throw new Error('翻译服务不可用(DSH LLM 服务缺席)');
	const catalog = await llmCatalog(ctx);
	if (!provider) provider = catalog.providers[0]?.name;
	if (!model) model = catalog.providers.find((p) => p.name === provider)?.models[0];
	if (!provider || !model) throw new Error('未找到可用的 DSH 模型(请在设置中选择)');
	const languageName = { 'zh-Hans': '简体中文', 'zh-Hant': '繁体中文', en: 'English', ja: '日本語', ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español' }[targetLanguage] || targetLanguage;
	// adversarial: a stream that never yields (hung provider) must not hang the
	// request — and the accumulating output — forever. Env var is a test seam.
	const timeoutMs = Number(process.env.DOC_READER_LLM_TIMEOUT_MS) || 90_000;
	const max = 4000;
	const parts = [];
	for (const chunk of splitForTranslate(text, max)) {
		const prompt = `你是一位专业翻译。把用户提供的文本翻译成${languageName}。只输出译文本身,不要任何解释、注释或原文。如果文本已经是${languageName},原样输出。\n\n<待翻译文本>\n${chunk}\n</待翻译文本>`;
		let out = '';
		let failure = null;
		const iterator = llm.stream({
			provider, model,
			messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
		})[Symbol.asyncIterator]();
		let pendingTimer = null;
		try {
			for (;;) {
				const next = await Promise.race([
					iterator.next(),
					new Promise((_, reject) => { pendingTimer = setTimeout(() => reject(new Error(`模型响应超时(${Math.round(timeoutMs / 1000)}s)`)), timeoutMs); }),
				]);
				clearTimeout(pendingTimer);
				if (next.done) break;
				const chunkEvent = next.value;
				if (!chunkEvent || typeof chunkEvent !== 'object') continue;
				if (chunkEvent.type === 'text-delta' && typeof chunkEvent.text === 'string') out += chunkEvent.text;
				else if (chunkEvent.type === 'finish') failure = chunkEvent.error?.message ?? null;
			}
		} finally {
			clearTimeout(pendingTimer);
			iterator.return?.().catch?.(() => {});
		}
		if (!out.trim()) throw new Error(failure || '模型未返回译文');
		parts.push(out.trim());
	}
	return parts.join('\n\n');
}

/** POST /translate { text, targetLanguage? } — optional ctx.translator bridge. */
async function handleTranslate(ctx, req, res) {
	let body;
	try {
		body = await readJsonBody(req, 256 * 1024);
	} catch {
		return fail(res, 400, 'invalid JSON body');
	}
	const text = String(body?.text ?? '');
	const targetLanguage = String(body?.targetLanguage || 'zh-Hans');
	if (!text.trim()) return fail(res, 400, 'text required');
	if (text.length > 200_000) return fail(res, 413, 'text too large');
	// adversarial: targetLanguage flows into URLs and prompts — whitelist it
	// instead of trusting the client, and the custom Google endpoint base URL
	// must be http(s) (blocks file:// and other exotic schemes from fetch).
	const LANGS = new Set(['zh-Hans', 'zh-Hant', 'en', 'ja', 'ko', 'fr', 'de', 'es']);
	if (!LANGS.has(targetLanguage)) return fail(res, 400, 'unsupported targetLanguage');
	if (body?.endpoint !== undefined && body?.endpoint !== '' && !/^https?:\/\/\S+$/u.test(String(body.endpoint))) {
		return fail(res, 400, 'endpoint must be an http(s) URL');
	}
	if (body?.engine === 'google') {
		try {
			const translated = await translateWithGoogle(text, targetLanguage, typeof body?.endpoint === 'string' ? body.endpoint : '');
			const payload = JSON.stringify({ ok: true, text: translated, engine: 'google' });
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			return res.end(payload);
		} catch (error) {
			return fail(res, 502, error?.message ?? String(error));
		}
	}
	if (body?.engine === 'dsh') {
		try {
			const translated = await translateWithLlm(ctx, text, targetLanguage, body?.provider, body?.model);
			const payload = JSON.stringify({ ok: true, text: translated, engine: 'dsh' });
			res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
			return res.end(payload);
		} catch (error) {
			return fail(res, 502, error?.message ?? String(error));
		}
	}
	const translator = typeof ctx.get === 'function' ? ctx.get('translator') : undefined;
	if (!translator || typeof translator.resolve !== 'function' || typeof translator.translate !== 'function') {
		return fail(res, 503, '翻译服务不可用(experimental-translator 未挂载)');
	}
	try {
		const max = Math.max(1, Number(translator.maxTextChars) || 4000);
		const chunks = splitForTranslate(text, max);
		const parts = [];
		for (const chunk of chunks) {
			const spec = await translator.resolve({ text: chunk, targetLanguage });
			parts.push(await translator.translate(spec));
		}
		const payload = JSON.stringify({ ok: true, text: parts.join('\n\n') });
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
		res.end(payload);
	} catch (error) {
		return fail(res, 502, `翻译失败:${error?.message ?? error}`);
	}
}

/** GET /convert?path=<encoded> — office document → cached PDF (libreoffice-kit). */
async function handleConvert(ctx, req, res, url) {
	const raw = url.searchParams.get('path');
	const resolved = await resolveReadable(raw);
	if (resolved.error) return fail(res, 400, resolved.error);
	if (!OFFICE.has(resolved.ext)) return fail(res, 400, 'not an office document');
	try {
		const pdfPath = await convertToPdf(resolved.file, resolved.info);
		const payload = JSON.stringify({ ok: true, pdfPath });
		res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
		return res.end(payload);
	} catch (error) {
		return fail(res, 502, error?.message ?? 'conversion failed');
	}
}

async function handleEvents(ctx, req, res, url, runtime) {
  if (req.method === 'HEAD') return fail(res, 405, 'GET only', req);
  let watchPath = null;
  const raw = url.searchParams.get('path');
  if (raw) {
    const resolved = await resolveReadable(raw);
    if (resolved.error) return fail(res, 400, resolved.error);
    watchPath = resolved.file;
  }
  // adversarial: cap concurrent SSE streams — a leaky client (or a script in
  // the app's own origin) must not be able to pile up unbounded connections
  const SSE_CLIENT_CAP = 16;
  if (runtime.sseClients.size >= SSE_CLIENT_CAP) return fail(res, 503, 'too many event streams');
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
    'connection': 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  const client = { res, watchPath };
  runtime.sseClients.add(client);
  if (watchPath && runtime.config.get().autoReloadEnabled) runtime.ensureWatch(watchPath);
  req.on('close', () => {
    runtime.sseClients.delete(client);
    if (watchPath) runtime.releaseWatch(watchPath);
  });
}
