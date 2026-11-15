// Builds DSH client chunks (client.vendor.js / client.pdfjs.js) from the
// libraries bundled inside the original VSIX extension.
// Usage: node build-vendor.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extRoot = path.join(here, '..', 'vsix-extract', 'extension', 'dist', 'node_modules');
const outDir = path.join(here, '..');
const esbuild = '/tmp/dsh-vendor-build/node_modules/.bin/esbuild';
const PKG = 'dsh-document-reader';
const buildDir = path.join(extRoot, '.drbuild');

fs.mkdirSync(buildDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

function run(args) {
  execFileSync(esbuild, args, { stdio: 'inherit' });
}

function wrapChunk(chunkName, globalName) {
  const body = fs.readFileSync(path.join(buildDir, `${chunkName}.bundle.js`), 'utf8');
  const out = `/* doc-reader ${chunkName} — built from the vscode-doc-reader 0.0.6 VSIX (Apache-2.0 pdfjs-dist; MIT markdown-it, jszip, docx-preview). */\n${body}\n;window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(PKG)},\n\tchunk: ${JSON.stringify(chunkName)},\n\tfactory() {\n\t\treturn globalThis.${globalName};\n\t}\n});\n`;
  fs.writeFileSync(path.join(outDir, chunkName), out);
  console.log(chunkName, (out.length / 1024).toFixed(0) + ' KiB');
}

// --- chunk 1: markdown-it + jszip + docx-preview -------------------------
// markdown-it and its dependency chain resolve through their CJS `main` files
// (present in the VSIX); jszip and docx-preview lost their package.json in the
// VSIX, so jszip is referenced by file and docx-preview runs from source text.
const docxSource = fs.readFileSync(
  path.join(extRoot, 'docx-preview', 'dist', 'docx-preview.min.js'), 'utf8',
);
fs.writeFileSync(
  path.join(buildDir, 'docx-text.cjs'),
  `module.exports = ${JSON.stringify(docxSource)};\n`,
);
fs.writeFileSync(path.join(buildDir, 'vendor-entry.cjs'), [
  "const MarkdownIt = require('markdown-it');",
  "const JSZip = require('../jszip/dist/jszip.min.js');",
  "const docxSource = require('./docx-text.cjs');",
  'function loadDocx() {',
  '  const mod = { exports: {} };',
  '  const shimRequire = (id) => {',
  "    if (id === 'jszip') return JSZip;",
  "    throw new Error('docx-preview: unexpected require ' + id);",
  '  };',
  "  new Function('module', 'exports', 'require', docxSource)(mod, mod.exports, shimRequire);",
  '  return mod.exports;',
  '}',
  'globalThis.__DR_VENDOR__ = { MarkdownIt, JSZip, loadDocx };',
  '',
].join('\n'));
run([
  path.join(buildDir, 'vendor-entry.cjs'),
  '--bundle', '--format=iife', '--platform=browser', '--minify',
  `--outfile=${path.join(buildDir, 'client.vendor.js.bundle.js')}`,
]);

// --- chunk 2: pdfjs-dist + worker source text -----------------------------
// import.meta.url appears only inside a Node-only branch; replace it so a
// classic script stays parseable.
const stripMeta = (s) => s.replace(/import\.meta\.url/g, '"file:///pdf.mjs"');
const pdfMjs = stripMeta(fs.readFileSync(path.join(extRoot, 'pdfjs-dist', 'build', 'pdf.mjs'), 'utf8'));
fs.writeFileSync(path.join(buildDir, 'pdf-lib.mjs'), pdfMjs);
fs.writeFileSync(path.join(buildDir, 'pdf-lib-index.mjs'), "export * from './pdf-lib.mjs';\n");
const workerSrc = stripMeta(
  fs.readFileSync(path.join(extRoot, 'pdfjs-dist', 'build', 'pdf.worker.mjs'), 'utf8'),
);
fs.writeFileSync(
  path.join(buildDir, 'worker-text.mjs'),
  `export default ${JSON.stringify(workerSrc)};\n`,
);
fs.writeFileSync(path.join(buildDir, 'pdfjs-entry.mjs'), [
  "import * as pdfjsLib from './pdf-lib-index.mjs';",
  "import workerText from './worker-text.mjs';",
  'globalThis.__DR_PDFJS__ = { pdfjsLib, workerText };',
  '',
].join('\n'));
run([
  path.join(buildDir, 'pdfjs-entry.mjs'),
  '--bundle', '--format=iife', '--platform=browser',
  `--outfile=${path.join(buildDir, 'client.pdfjs.js.bundle.js')}`,
]);

wrapChunk('client.vendor.js', '__DR_VENDOR__');
wrapChunk('client.pdfjs.js', '__DR_PDFJS__');
console.log('done');
