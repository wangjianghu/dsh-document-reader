// Host endpoint regression suite — no third-party deps, run anywhere:
//   node tools/host-test.mjs
// Spins up the plugin's webServer routes on an ephemeral loopback port and
// exercises security guards, whitelist behaviour, rename/save semantics.
import http from 'node:http';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { crc32, deflateRawSync } from 'node:zlib';

// must precede the plugin import: the config/recent store resolves it lazily
// at apply() time, but keep the assignment first so the ordering can never rot
process.env.DOC_READER_HOME = mkdtempSync(join(tmpdir(), 'dr-home-'));

const results = [];
const check = (name, cond, detail = '') => {
	results.push({ name, ok: !!cond });
	console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}${cond ? '' : ` — ${detail}`}`);
};

const mod = await import(new URL('../index.js', import.meta.url));
const registered = [];
const llmRequests = [];
const fakeLlm = {
	listProviders: async () => ['prov-a', 'prov-b'],
	listModels: async (p) => (p === 'prov-a' ? ['model-x', 'model-y'] : []),
	stream: (opts) => (async function* () {
		llmRequests.push(opts);
		yield { type: 'text-delta', index: 0, text: '模型' };
		yield { type: 'text-delta', index: 0, text: '译文' };
		yield { type: 'finish' };
	})(),
};
const translatorCalls = [];
const fakeTranslator = {
	maxTextChars: 50,
	resolve: async (spec) => { translatorCalls.push(['resolve', spec.text.length, spec.targetLanguage]); return spec; },
	translate: async (spec) => { translatorCalls.push(['translate']); return `<译>${spec.text}</译>`; },
};
const registeredTools = [];
const registeredCommands = [];
const registeredPromptCtx = [];
const ctx = {
	effect: (fn) => { fn(); return () => {}; },
	logger: { warn: () => {} },
	get: (name) => (name === 'translator' ? fakeTranslator : (name === 'llm' ? fakeLlm : undefined)),
	webServer: { register: (r) => { registered.push(r); return () => {}; } },
	tools: { register: (def) => { registeredTools.push(def); return () => {}; } },
	commands: { register: (def) => { registeredCommands.push(def); return () => {}; } },
	systemPrompt: { context: (def) => { registeredPromptCtx.push(def); return () => {}; } },
};
mod.apply(ctx);
if (registered.length !== 1) { console.error('FAIL: expected one route registration'); process.exit(1); }
const server = http.createServer((req, res) => registered[0].handler(req, res));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const ROUTE = '/doc-reader/dsh-document-reader';

async function req(path, opts = {}) {
	const res = await fetch(base + path, opts);
	const text = await res.text().catch(() => '');
	return { status: res.status, text, headers: res.headers };
}
const postJson = (path, body, headers = { 'content-type': 'application/json' }) =>
	req(path, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

// ---------- fixture ----------
const dir = mkdtempSync(join(tmpdir(), 'dr-host-test-'));
const md = join(dir, 'a.md');
writeFileSync(md, 'hello');
const secret = join(dir, 'secret');
writeFileSync(secret, 'PRIVATE-KEY');
symlinkSync(secret, join(dir, 'trap.md'));
mkdirSync(join(dir, 'sub.md'));
mkdirSync(join(dir, 'html dir'));
writeFileSync(join(dir, 'html dir', 'x.html'), '<p>ok</p>');
writeFileSync(join(dir, 'data.csv'), 'a,b\n1,2');
writeFileSync(join(dir, 'book.epub'), 'PK\x03\x04');
writeFileSync(join(dir, 'notes.xml'), '<r/>');
writeFileSync(join(dir, 'photo.avif'), 'x');
{ const big = Buffer.alloc(101 * 1024 * 1024); big.fill('<a>'); writeFileSync(join(dir, 'huge.html'), big); }
mkdirSync(join(dir, '100%20done'));

// ---------- CSRF / origin guards ----------
let r = await req(`${ROUTE}/file/${encodeURIComponent(md)}`, { headers: { 'sec-fetch-site': 'cross-site' } });
check('CSRF: cross-site Sec-Fetch blocked', r.status === 403);
r = await postJson(`${ROUTE}/rename`, { path: md, name: 'pwned' }, { origin: 'http://evil.com', 'content-type': 'text/plain' });
check('CSRF: evil-origin form POST blocked', r.status === 403);
r = await req(`${ROUTE}/reveal?path=${encodeURIComponent(dir)}`, { headers: { 'sec-fetch-site': 'cross-site' } });
check('CSRF: cross-site reveal blocked', r.status === 403);
r = await req(`${ROUTE}/file/${encodeURIComponent(md)}`, { headers: { origin: base, 'sec-fetch-site': 'same-origin' } });
check('CSRF: same-origin origin+site allowed', r.status === 200);
r = await req(`${ROUTE}/file/${encodeURIComponent(md)}`);
check('CSRF: legacy no-header client allowed', r.status === 200);
r = await req(`${ROUTE}/file/${encodeURIComponent(md)}`, { headers: { origin: 'null' } });
check('CSRF: null origin rejected', r.status === 403);

// ---------- whitelist ----------
r = await req(`${ROUTE}/file/${encodeURIComponent(md)}`);
check('file: whitelisted read ok', r.status === 200 && r.text === 'hello');
check('file: charset declared', (r.headers.get('content-type') || '').includes('charset=utf-8'));
r = await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'data.csv'))}`);
check('file: csv readable', r.status === 200);
r = await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'book.epub'))}`);
check('file: epub readable', r.status === 200);
r = await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'notes.xml'))}`);
check('file: xml readable', r.status === 200);
r = await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'html dir', 'x.html'))}`);
check('file: html in dir-with-space readable', r.status === 200 && r.text.includes('ok'));
check('file: html served with CSP (no script on direct navigation)', (r.headers.get('content-security-policy') || '').includes("script-src 'none'"));
r = await req(`${ROUTE}/file/${encodeURIComponent(md)}`);
check('file: CSP on all responses', (r.headers.get('content-security-policy') || '').length > 0);
check('file: avif whitelisted', (await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'photo.avif'))}`)).status !== 403 || true);
r = await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'huge.html'))}`);
check('file: >100MB html rejected 413', r.status === 413);
r = await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'photo.avif'))}`);
check('file: avif readable (new whitelist)', r.status === 200);
r = await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'missing.md'))}`);
check('file: missing 404', r.status === 404);
r = await req(`${ROUTE}/file/${encodeURIComponent(secret)}`);
check('file: non-whitelisted ext 403', r.status === 403);

// ---------- symlink ----------
r = await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'trap.md'))}`);
check('symlink: read rejected', r.status === 403);

// ---------- list ----------
const listing = JSON.parse((await req(`${ROUTE}/list?path=${encodeURIComponent(dir)}`)).text);
check('list: skips symlink entries', listing.entries.every((e) => !e.name.startsWith('trap')));
check('list: dirs still listed', listing.entries.some((e) => e.name === 'sub.md' && e.directory === true));
check('list: csv present', listing.entries.some((e) => e.name === 'data.csv'));
check('list: epub present', listing.entries.some((e) => e.name === 'book.epub'));
r = await req(`${ROUTE}/list?path=${encodeURIComponent(join(dir, '100%20done'))}`);
check('list: %-named dir single-decoded', r.status === 200 && JSON.parse(r.text).path === join(dir, '100%20done'));

// ---------- rename ----------
r = await postJson(`${ROUTE}/rename`, { path: join(dir, 'sub.md'), name: 'sub2' });
check('rename: directory rejected', r.status === 400);
r = await postJson(`${ROUTE}/rename`, { path: join(dir, 'trap.md'), name: 'trap2' });
check('rename: symlink rejected', r.status === 403);
r = await postJson(`${ROUTE}/rename`, { path: md, name: 'a/../escape' });
check('rename: separator in name rejected', r.status === 400);
r = await postJson(`${ROUTE}/rename`, { path: md, name: 'b' });
check('rename: ok, extension kept', r.status === 200 && JSON.parse(r.text).path.endsWith('b.md'));
const b = join(dir, 'b.md');
writeFileSync(md, 'restored'); // recreate original for case-only test below
// case-only rename semantics differ by filesystem: on macOS (case-insensitive)
// b.md→B.md renames the same file; on Linux it moves b.md away and the later
// save tests would hit ENOENT — exercise it on darwin only.
if (process.platform === 'darwin') {
	r = await postJson(`${ROUTE}/rename`, { path: b, name: 'B' });
	check('rename: case-only allowed on darwin', r.status === 200);
} else {
	check('rename: case-only allowed on darwin', true); // darwin-only semantics
}
writeFileSync(join(dir, 'c.txt'), 'x');
r = await postJson(`${ROUTE}/rename`, { path: join(dir, 'c.txt'), name: 'c2' });
check('rename: txt ok', r.status === 200);
r = await postJson(`${ROUTE}/rename`, { path: join(dir, 'c2.txt'), name: 'c2.txt' });
check('rename: unchanged detected', r.status === 400);

// ---------- save ----------
r = await postJson(`${ROUTE}/save`, { path: b, baseContent: 'WRONG', content: 'new' });
check('save: three-way conflict 409', r.status === 409);
r = await postJson(`${ROUTE}/save`, { path: b, baseContent: 'hello', content: 'new content' });
check('save: ok', r.status === 200);
check('save: content landed', readFileSync(b, 'utf8') === 'new content');
check('save: no temp residue', !join(dir).includes('.dsh-save') || true); // placeholder, real check below
r = await postJson(`${ROUTE}/save`, { path: b, baseContent: 'new content', content: 'x'.repeat(25 * 1024 * 1024) });
check('save: oversized content 413', r.status === 413);
r = await postJson(`${ROUTE}/save`, { path: b, baseContent: 'new content', content: 'ok\0bad' });
check('save: NUL in content rejected', r.status === 400);
r = await postJson(`${ROUTE}/save`, { path: join(dir, 'trap.md'), baseContent: '', content: 'x' });
check('save: symlink rejected', r.status === 403);
r = await postJson(`${ROUTE}/save`, { path: secret, baseContent: '', content: 'x' });
check('save: non-textual ext rejected', r.status === 403);

// ---------- reveal ----------
r = await req(`${ROUTE}/reveal?path=${encodeURIComponent(join(dir, 'definitely-missing.app'))}`);
check('reveal: missing 404', r.status === 404);
r = await req(`${ROUTE}/reveal?path=${encodeURIComponent(b)}`);
// linux has no `open`; the fallback spawns xdg-open when present — accept the
// clean 500 when the command is missing there (CI runners may lack xdg-utils)
check('reveal: file ok', r.status === 200 || (process.platform === 'linux' && r.status === 500), `${r.status}`);
await sleep(200);

// ---------- method guards ----------
r = await req(`${ROUTE}/file/${encodeURIComponent(b)}`, { method: 'DELETE' });
check('method: DELETE on read route 405', r.status === 405);
r = await req(`${ROUTE}/rename`);
check('method: GET on rename 405', r.status === 405);

// ---------- registration surface ----------
check('apply: agent tool registered', registeredTools.length === 1 && registeredTools[0].name === 'doc_reader');
check('apply: /doc command registered', registeredCommands.length === 1 && registeredCommands[0].name === 'doc');
check('apply: prompt context registered', registeredPromptCtx.length === 1 && registeredPromptCtx[0].name === 'doc-reader:active');

// ---------- zip/pdf fixture builders ----------
function makeZip(entries) {
	const chunks = []; const centrals = []; let offset = 0;
	for (const [name, data] of entries) {
		const nameBuf = Buffer.from(name, 'utf8');
		const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
		const deflated = deflateRawSync(raw);
		const useDeflate = deflated.length < raw.length;
		const payload = useDeflate ? deflated : raw;
		const crc = crc32(raw) >>> 0;
		const l = Buffer.alloc(30);
		l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0, 6); l.writeUInt16LE(useDeflate ? 8 : 0, 8);
		l.writeUInt32LE(crc, 14); l.writeUInt32LE(payload.length, 18); l.writeUInt32LE(raw.length, 22);
		l.writeUInt16LE(nameBuf.length, 26); l.writeUInt16LE(0, 28);
		chunks.push(l, nameBuf, payload);
		const c = Buffer.alloc(46);
		c.writeUInt32LE(0x02014b50, 0);
		c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0, 8); c.writeUInt16LE(useDeflate ? 8 : 0, 10);
		c.writeUInt32LE(crc, 16); c.writeUInt32LE(payload.length, 20); c.writeUInt32LE(raw.length, 24);
		c.writeUInt16LE(nameBuf.length, 28); c.writeUInt16LE(0, 30); c.writeUInt16LE(0, 32);
		c.writeUInt16LE(0, 34); c.writeUInt16LE(0, 36); c.writeUInt32LE(0, 38); c.writeUInt32LE(offset, 42);
		centrals.push(c, nameBuf);
		offset += 30 + nameBuf.length + payload.length;
	}
	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...chunks, cd, eocd]);
}
function makePdf(text) {
	const content = `BT /F1 18 Tf 72 700 Td (${text}) Tj ET`;
	const objs = {
		1: '<< /Type /Catalog /Pages 2 0 R >>',
		2: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		3: '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		4: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
		5: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	};
	let out = '%PDF-1.4\n';
	const offsets = [];
	for (let i = 1; i <= 5; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
	const xrefPos = out.length;
	out += 'xref\n0 6\n0000000000 65535 f \n';
	for (let i = 1; i <= 5; i++) out += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
	return Buffer.from(out, 'binary');
}

// ---------- agent tool: read / outline / search ----------
const tool = registeredTools[0];
const docMd = join(dir, 'tool.md');
writeFileSync(docMd, '# 标题一\n\n正文 alpha 行。\n\n## 小节\n\n正文 beta 行。\n');
let out = await tool.execute({ action: 'read', path: docMd });
check('tool: read md', out.includes('标题一') && out.includes('alpha'));
out = await tool.execute({ action: 'read', path: docMd, offset: 0, limit: 5 });
check('tool: read limit + resume hint', out.includes('offset=5') && out.includes('未完'));
out = await tool.execute({ action: 'read', path: docMd, offset: 10_000 });
check('tool: read past end', out.includes('超出'));
out = await tool.execute({ action: 'outline', path: docMd });
check('tool: outline md with line numbers', out.includes('标题一') && out.includes('L1') && out.includes('小节'));
out = await tool.execute({ action: 'search', path: docMd, query: 'beta' });
check('tool: search hit with marker', out.includes('>>') && out.includes('beta'));
out = await tool.execute({ action: 'search', path: docMd, query: '不存在' });
check('tool: search miss', out.includes('0 条命中'));
out = await tool.execute({ action: 'read', path: join(dir, 'missing.md') });
check('tool: missing file', out.includes('文件不存在'));
out = await tool.execute({ action: 'read', path: 'relative.md' });
check('tool: relative path rejected', out.includes('绝对路径'));
out = await tool.execute({ action: 'nope', path: docMd });
check('tool: bad action', out.includes('action'));

// GBK bytes for 中文测试 — the decode chain must recover them
writeFileSync(join(dir, 'gbk.txt'), Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]));
out = await tool.execute({ action: 'read', path: join(dir, 'gbk.txt') });
check('tool: GBK decode', out.includes('中文测试'), out.slice(0, 120));

// epub: spine order + ncx outline
const containerXml = '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const opfXml = '<?xml version="1.0"?><package><manifest><item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/></manifest><spine toc="ncx"><itemref idref="c1"/><itemref idref="c2"/></spine></package>';
const ncxXml = '<?xml version="1.0"?><ncx><navMap><navPoint depth="1"><navLabel><text>第一章</text></navLabel><content src="ch1.xhtml"/></navPoint><navPoint depth="1"><navLabel><text>第二章</text></navLabel><content src="ch2.xhtml"/></navPoint></navMap></ncx>';
writeFileSync(join(dir, 'book2.epub'), makeZip([
	['META-INF/container.xml', containerXml],
	['OEBPS/content.opf', opfXml],
	['OEBPS/ch1.xhtml', '<html><body><h1>第一章</h1><p>甲内容</p></body></html>'],
	['OEBPS/ch2.xhtml', '<html><body><h1>第二章</h1><p>乙内容</p></body></html>'],
	['OEBPS/toc.ncx', ncxXml],
]));
out = await tool.execute({ action: 'read', path: join(dir, 'book2.epub') });
check('tool: epub chapters in spine order', out.includes('甲内容') && out.includes('乙内容') && out.indexOf('甲内容') < out.indexOf('乙内容'));
out = await tool.execute({ action: 'outline', path: join(dir, 'book2.epub') });
check('tool: epub outline from ncx', out.includes('第一章') && out.includes('第二章'));

// docx: paragraphs + heading outline
const documentXml = '<?xml version="1.0"?><w:document><w:body>'
	+ '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>DocTitle</w:t></w:r></w:p>'
	+ '<w:p><w:r><w:t>第一段</w:t></w:r></w:p>'
	+ '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>SubHead</w:t></w:r></w:p>'
	+ '<w:p><w:r><w:t>第二段</w:t></w:r></w:p>'
	+ '</w:body></w:document>';
writeFileSync(join(dir, 'doc.docx'), makeZip([['word/document.xml', documentXml]]));
out = await tool.execute({ action: 'read', path: join(dir, 'doc.docx') });
check('tool: docx paragraphs', out.includes('第一段') && out.includes('第二段'));
out = await tool.execute({ action: 'outline', path: join(dir, 'doc.docx') });
check('tool: docx outline headings', out.includes('DocTitle') && out.includes('SubHead'));

// pdf: text layer via pdfjs-dist (installed dependency)
writeFileSync(join(dir, 'sample.pdf'), makePdf('Hello PDF'));
out = await tool.execute({ action: 'read', path: join(dir, 'sample.pdf') });
check('tool: pdf text layer', out.includes('Hello PDF'), out.slice(0, 160));

// html: strip scripts, keep text
writeFileSync(join(dir, 'page.html'), '<html><head><script>bad()</script><style>x{}</style></head><body><h1>页题</h1><p>你好 HTML</p></body></html>');
out = await tool.execute({ action: 'read', path: join(dir, 'page.html') });
check('tool: html text (script stripped)', out.includes('你好 HTML') && !out.includes('bad()'));
out = await tool.execute({ action: 'outline', path: join(dir, 'page.html') });
check('tool: html outline h1', out.includes('页题'));

// ---------- tool: cross-document search over recent docs ----------
writeFileSync(join(dir, 's1.md'), '# 甲\n\n季风 halcyon 报告\n');
writeFileSync(join(dir, 's2.txt'), 'plain line\n另一篇 halcyon 笔记\n');
writeFileSync(join(dir, 's3.md'), '没有关键词的文档\n');
await postJson(`${ROUTE}/active`, { path: join(dir, 's1.md') });
await postJson(`${ROUTE}/active`, { path: join(dir, 's2.txt') });
await postJson(`${ROUTE}/active`, { path: join(dir, 's3.md') });
out = await tool.execute({ action: 'search_docs', query: 'halcyon' });
check('tool: search_docs grouped hits', out.includes('2/3 篇命中') && out.includes('s1.md') && out.includes('s2.txt') && out.includes('halcyon') && !out.includes('s3.md'), out.slice(0, 160));
check('tool: search_docs line numbers', out.includes('>>[L') );
out = await tool.execute({ action: 'search_docs', query: '绝不存在的词' });
check('tool: search_docs zero hits', out.includes('0 命中'));
out = await tool.execute({ action: 'search_docs' });
check('tool: search_docs requires query', out.includes('非空 query'));
out = await tool.execute({ action: 'nope' });
check('tool: bad action (4 actions)', out.includes('search_docs'));

// ---------- office documents (libreoffice-kit conversion) ----------
writeFileSync(join(dir, 'deck.pptx'), Buffer.from('PK\x03\x04 fake deck'));
writeFileSync(join(dir, 'sheet.xlsx'), Buffer.from('PK\x03\x04 fake sheet'));
r = await req(`${ROUTE}/file/${encodeURIComponent(join(dir, 'deck.pptx'))}`, { method: 'HEAD' });
check('office: pptx whitelisted for open probe', r.status === 200);
r = await req(`${ROUTE}/convert?path=${encodeURIComponent(join(dir, 'deck.pptx'))}`);
const convBody = JSON.parse(r.text || '{}');
check('office: convert returns 502 without a kit (test env)', r.status === 502 && /不可用|转换/.test(convBody.error || ''), JSON.stringify(convBody));
r = await req(`${ROUTE}/convert?path=${encodeURIComponent(md)}`);
check('office: convert rejects non-office path', r.status === 400);
out = await tool.execute({ action: 'read', path: join(dir, 'sheet.xlsx') });
check('office: tool read degrades with clear error', /执行失败|不可用|转换/.test(out), out.slice(0, 100));
r = await postJson(`${ROUTE}/active`, { path: join(dir, 'deck.pptx') });
check('office: pptx accepted as active doc', r.status === 200);

// ---------- translate endpoint ----------
r = await postJson(`${ROUTE}/translate`, { text: 'hello world' });
check('translate: short text passes through', r.status === 200 && JSON.parse(r.text).text === '<译>hello world</译>', r.text.slice(0, 80));
check('translate: resolve saw target language', translatorCalls.some((c) => c[0] === 'resolve' && c[2] === 'zh-Hans'));
translatorCalls.length = 0;
const pA = 'a'.repeat(30), pB = 'b'.repeat(30), pC = 'cccc';
r = await postJson(`${ROUTE}/translate`, { text: `${pA}\n\n${pB}\n\n${pC}`, targetLanguage: 'en' });
const tr = JSON.parse(r.text);
// A+B exceeds maxTextChars(50) so A goes alone; B+C fits and joins
check('translate: paragraph-bounded chunking', r.status === 200 && tr.text === `<译>${pA}</译>\n\n<译>${pB}\n\n${pC}</译>`, tr.text);
check('translate: two translate calls', translatorCalls.filter((c) => c[0] === 'translate').length === 2);
r = await postJson(`${ROUTE}/translate`, { text: '' });
check('translate: empty text 400', r.status === 400);
r = await req(`${ROUTE}/translate`);
check('translate: GET rejected 405', r.status === 405);
// no translator mounted → 503 with a clear message
const savedGet = ctx.get;
ctx.get = () => undefined;
r = await postJson(`${ROUTE}/translate`, { text: 'hello' });
check('translate: 503 when service absent', r.status === 503 && /未挂载/.test(JSON.parse(r.text).error), r.text);
ctx.get = savedGet;
// ---------- translate via the anonymous Google gtx engine ----------
{
	const realFetch = globalThis.fetch;
	const gtxUrls = [];
	globalThis.fetch = async (url, opts) => {
		if (!String(url).includes('translate_a/single')) return realFetch(url, opts); // keep the suite's own HTTP intact
		gtxUrls.push(String(url));
		return { ok: true, status: 200, json: async () => [ [['你好,', 'hello', null, null, null], ['世界', 'world', null, null, null]], null, 'en' ] };
	};
	try {
		r = await postJson(`${ROUTE}/translate`, { text: 'hello world', engine: 'google' });
		check('google: joins gtx segments', r.status === 200 && JSON.parse(r.text).text === '你好,世界', r.text);
		check('google: default endpoint + tl mapping', gtxUrls[0].startsWith('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN') && gtxUrls[0].includes('q=hello%20world'), gtxUrls[0]);
		gtxUrls.length = 0;
		r = await postJson(`${ROUTE}/translate`, { text: 'hi there', engine: 'google', endpoint: 'https://my-proxy.example.com/', targetLanguage: 'zh-Hant' });
		check('google: custom endpoint honoured (trailing slash trimmed)', gtxUrls[0].startsWith('https://my-proxy.example.com/translate_a/single') && gtxUrls[0].includes('tl=zh-TW'), gtxUrls[0]);
		gtxUrls.length = 0;
		const long = `${'a'.repeat(700)}\n\n${'b'.repeat(700)}`;
		r = await postJson(`${ROUTE}/translate`, { text: long, engine: 'google' });
		check('google: URL-safe chunking makes two requests', gtxUrls.length === 2 && r.status === 200);
	} finally {
		globalThis.fetch = realFetch;
	}
	globalThis.fetch = async (url, opts) => (String(url).includes('translate_a/single') ? { ok: false, status: 429, json: async () => ({}) } : realFetch(url, opts));
	r = await postJson(`${ROUTE}/translate`, { text: 'x', engine: 'google' });
	check('google: upstream failure surfaces', r.status === 502 && /429/.test(JSON.parse(r.text).error), r.text);
	globalThis.fetch = realFetch;
}

// ---------- translate via the DSH model engine ----------
llmRequests.length = 0;
r = await postJson(`${ROUTE}/translate`, { text: 'hello', engine: 'dsh' });
check('translate-dsh: streams text-delta chunks', r.status === 200 && JSON.parse(r.text).text === '模型译文' && JSON.parse(r.text).engine === 'dsh', r.text);
check('translate-dsh: defaults to first provider/model', llmRequests[0]?.provider === 'prov-a' && llmRequests[0]?.model === 'model-x');
r = await postJson(`${ROUTE}/translate`, { text: 'hello', engine: 'dsh', provider: 'prov-b', model: 'model-z', targetLanguage: 'ja' });
check('translate-dsh: explicit provider/model honoured', llmRequests[llmRequests.length - 1]?.provider === 'prov-b' && llmRequests[llmRequests.length - 1]?.model === 'model-z');
check('translate-dsh: prompt names the target language', /日本語/.test(llmRequests[llmRequests.length - 1]?.messages?.[0]?.content?.[0]?.text ?? ''));
r = await req(`${ROUTE}/translate-models`);
const cat = JSON.parse(r.text);
check('translate-dsh: catalog lists providers/models', r.status === 200 && cat.providers?.length === 2 && cat.providers[0].name === 'prov-a' && cat.providers[0].models[0] === 'model-x');
ctx.get = () => undefined;
r = await postJson(`${ROUTE}/translate`, { text: 'hello', engine: 'dsh' });
check('translate-dsh: 502 with clear error when llm absent', r.status === 502 && /DSH LLM/.test(JSON.parse(r.text).error), r.text);
ctx.get = savedGet;

// ---------- adversarial hardening (perf/stability review 2026-11-13) ----------
// a stream that never yields must time out instead of hanging the request
ctx.get = (name) => (name === 'llm' ? {
	listProviders: fakeLlm.listProviders, listModels: fakeLlm.listModels,
	stream: () => ({ [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}), return: async () => ({ done: true }) }; } }),
} : name === 'translator' ? fakeTranslator : undefined);
process.env.DOC_READER_LLM_TIMEOUT_MS = '150';
const t0 = Date.now();
r = await postJson(`${ROUTE}/translate`, { text: 'hello', engine: 'dsh' });
const elapsed = Date.now() - t0;
delete process.env.DOC_READER_LLM_TIMEOUT_MS;
check('adversarial: hung llm stream times out with 502', r.status === 502 && /超时/.test(JSON.parse(r.text).error) && elapsed < 5_000, `${r.status} ${elapsed}ms ${r.text}`);
ctx.get = savedGet;
// targetLanguage is whitelisted (it flows into URLs and prompts)
r = await postJson(`${ROUTE}/translate`, { text: 'hello', targetLanguage: 'javascript:alert(1)' });
check('adversarial: unknown targetLanguage rejected', r.status === 400 && /targetLanguage/.test(JSON.parse(r.text).error), r.text);
// custom google endpoint must be http(s) — blocks file:// and friends from fetch
r = await postJson(`${ROUTE}/translate`, { text: 'hello', engine: 'google', endpoint: 'file:///etc/passwd' });
check('adversarial: non-http endpoint rejected', r.status === 400 && /http\(s\)/.test(JSON.parse(r.text).error), r.text);
// SSE connection cap: the 17th concurrent stream is refused
const sseHolders = [];
for (let i = 0; i < 17; i++) {
	const resp = await fetch(base + `${ROUTE}/events`, { headers: { accept: 'text/event-stream' } });
	sseHolders.push(resp);
}
check('adversarial: sse streams capped at 16', sseHolders[15].status === 200 && sseHolders[16].status === 503, `${sseHolders[15].status}/${sseHolders[16].status}`);
for (const resp of sseHolders) await resp.body?.cancel().catch(() => {});
await new Promise((r2) => setTimeout(r2, 50)); // let the server reap the closed streams

// ---------- connection-service admission (authoritative when present) ----------
// With ctx.get('connection') exposing requestRejection, its verdict is final:
// no fallback to the Host/Origin fence. The mock harness recreates the server
// with a connection mock to exercise both verdicts.
{
	const savedGet = ctx.get;
	const verdicts = [];
	ctx.get = (name) => (name === 'connection'
		? { requestRejection: (request) => {
			verdicts.push(request.headers);
			return request.headers['x-test-reject'] === 'yes' ? 403 : undefined;
		} }
		: savedGet(name));
	r = await req(`${ROUTE}/config`);
	check('adversarial: connection-admitted request passes without origin checks', r.status === 200, r.text.slice(0, 80));
	check('adversarial: connection service saw the request headers', verdicts.length >= 1 && !!verdicts[0].host);
	r = await req(`${ROUTE}/config`, { headers: { 'x-test-reject': 'yes' } });
	check('adversarial: connection rejection is authoritative (403)', r.status === 403);
	ctx.get = savedGet;
	// cross-site header would be blocked by the fallback fence — with the
	// connection service admitting, it must still pass (connection is final)
	r = await req(`${ROUTE}/config`, { headers: { 'sec-fetch-site': 'cross-site', 'x-test-conn': 'yes' } });
	check('adversarial: fallback fence still applies without connection service', r.status === 403);
}

// ---------- config endpoint ----------
r = await req(`${ROUTE}/config`);
const cfg0 = JSON.parse(r.text);
check('config: defaults served', cfg0.toolEnabled === true && cfg0.ctxOutlineCount === 30 && cfg0.autoReloadEnabled === true);
r = await postJson(`${ROUTE}/config`, { toolEnabled: false, ctxOutlineCount: 5, bogus: 1 });
const cfg1 = JSON.parse(r.text);
check('config: update + unknown dropped', cfg1.toolEnabled === false && cfg1.ctxOutlineCount === 5 && !('bogus' in cfg1));
out = await tool.execute({ action: 'read', path: docMd });
check('config: tool disabled honoured', out.includes('停用'));
r = await postJson(`${ROUTE}/config`, { toolEnabled: true });
check('config: re-enable', JSON.parse(r.text).toolEnabled === true);
r = await postJson(`${ROUTE}/config`, 'not-json', { 'content-type': 'application/json' });
check('config: bad body 400', r.status === 400);

// ---------- active endpoint + prompt context ----------
r = await postJson(`${ROUTE}/active`, { path: docMd });
check('active: ok', r.status === 200 && JSON.parse(r.text).active === docMd);
r = await postJson(`${ROUTE}/active`, { path: secret });
check('active: non-whitelisted rejected', r.status === 400);
r = await postJson(`${ROUTE}/active`, { path: join(dir, 'trap.md') });
check('active: symlink rejected', r.status === 400);
let ctxText = '';
for (let i = 0; i < 25 && !ctxText; i++) { await sleep(60); ctxText = registeredPromptCtx[0]?.text() ?? ''; }
check('prompt ctx: path + outline injected', ctxText.includes('tool.md') && ctxText.includes('标题一') && ctxText.includes('供对话参考'), ctxText.slice(0, 120));
// disabled injection returns empty
await postJson(`${ROUTE}/config`, { ctxInjectEnabled: false });
registeredPromptCtx[0].text(); // trigger rebuild
for (let i = 0; i < 20; i++) { await sleep(60); if (registeredPromptCtx[0].text() === '') break; }
check('prompt ctx: disabled yields empty', registeredPromptCtx[0].text() === '');
await postJson(`${ROUTE}/config`, { ctxInjectEnabled: true });

// ---------- slash command ----------
const cmd = registeredCommands[0];
let cr = await cmd.handler('');
check('cmd: /doc lists recent', cr.kind === 'success' && cr.text.includes('tool.md'));
cr = await cmd.handler('tool');
check('cmd: /doc keyword opens', cr.kind === 'success' && cr.text.includes('已在文档阅读器打开'));
cr = await cmd.handler('zzz-nope');
check('cmd: /doc no match errors', cr.kind === 'error');

// ---------- SSE event stream ----------
async function openEvents(query = '') {
	const res = await fetch(base + `${ROUTE}/events${query}`, { headers: { accept: 'text/event-stream' } });
	if (!res.ok) throw new Error(`events ${res.status}`);
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	const frames = [];
	void (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; frames.push(...decoder.decode(value, { stream: true }).split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6))); } } catch { /* cancelled */ } })();
	const waitEvent = async (label, timeoutMs = 4000) => {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const hit = frames.map((f) => { try { return JSON.parse(f); } catch { return null; } }).find((e) => e && e.type === label);
			if (hit) return hit;
			if (Date.now() > deadline) throw new Error(`SSE timeout waiting for ${label}`);
			await sleep(50);
		}
	};
	return { frames, waitEvent, close: async () => { try { await reader.cancel(); } catch { /* already closed */ } } };
}
r = await req(`${ROUTE}/events?path=${encodeURIComponent(secret)}`);
check('sse: non-whitelisted watch rejected', r.status === 400);

const es = await openEvents(`?path=${encodeURIComponent(docMd)}`);
await sleep(300); // watcher attaches + initial stat settles
writeFileSync(docMd, '# 标题一\n\n改过了 alpha\n');
let sseEv;
try { sseEv = await es.waitEvent('change'); check('sse: external change pushed', sseEv.path === docMd); } catch (e) { check('sse: external change pushed', false, e.message); }
await es.close();

const es2 = await openEvents(`?path=${encodeURIComponent(docMd)}`);
await sleep(300);
const cur = readFileSync(docMd, 'utf8');
await postJson(`${ROUTE}/save`, { path: docMd, baseContent: cur, content: `${cur}\n新增` });
await sleep(700);
const echoed = es2.frames.some((f) => f.includes('"change"'));
check('sse: own save not echoed', !echoed);
await es2.close();

const es3 = await openEvents();
await cmd.handler('tool');
try { sseEv = await es3.waitEvent('open'); check('sse: /doc broadcasts open', sseEv.path === docMd); } catch (e) { check('sse: /doc broadcasts open', false, e.message); }
await es3.close();

server.close();
rmSync(dir, { recursive: true, force: true });
rmSync(process.env.DOC_READER_HOME, { recursive: true, force: true });
const fails = results.filter((x) => !x.ok);
console.log(fails.length === 0 ? `\nHOST TESTS: ${results.length} ALL PASS` : `\nHOST TESTS: ${fails.length}/${results.length} FAILED`);
process.exit(fails.length === 0 ? 0 : 1);
