# dsh-document-reader

A dedicated document & image reader panel for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). Open local files in a real reader surface instead of chat attachments — and let the assistant read along.

[English](#features) · [中文说明](#中文说明)

## Features

- **Formats**: PDF (continuous scroll, text-layer search, zoom/rotate/fit), DOCX (headers/footers/footnotes, virtual pages), EPUB (chapter rendering with scoped CSS, whole-book search), HTML (sanitized), Markdown, plain text (multi-encoding: UTF-8/GBK/Big5/Shift-JIS), images (zoom/rotate/fit-window), and Office decks & spreadsheets (`.pptx .xlsx .ppt .xls .doc` — converted to PDF through the LibreOffice engine bundled with DSH, cached by content hash).
- **Reading essentials**: outline navigation, in-document search with match highlighting, structured scroll-position restore per file, rename in place, recent files, dark/light theme tokens, English / Simplified / Traditional Chinese UI.
- **Editing**: Markdown and plain-text edit mode (Ctrl/Cmd+S), unsaved-draft recovery, conflict detection when the file changes on disk, external-change auto-reload.
- **Selection actions**: select text anywhere → floating bar for *quote to chat*, *copy*, *search in document*, *translate*.
- **Translation** (all three engines built in — pick one in ⚙ Settings): Bing (anonymous, via the translator service shipped with DSH), Google gtx (anonymous, custom endpoint supported), or **your configured DSH model** via `ctx.llm` (e.g. GLM). Result dialog shows source text + translation, retry, copy.
- **AI integration**: a `doc_reader` agent tool (read / outline / search any supported format), active-document outline injected into chat context (toggleable), a `/doc` slash command for fuzzy-opening recent documents, tool-result cards in chat with "open in reader".
- **Polish**: copy-path toolbar button, status-bar feedback, instant dark tooltips, global shortcut Cmd/Ctrl+Shift+O, per-view settings (font size, line height, PDF text layer, DOCX pagination, UI language).

Security posture: extension whitelist, symlink rejection, atomic writes, loopback + cross-site guards on all Host routes, sanitized HTML/EPUB rendering, size caps and timeouts everywhere.

## Install

Requires DSH with the plugin system (dsh ≥ 0.2.0).

**A. From a plugin market (Discover)** — add an index source that lists this package (any index that mirrors `dsh-plugin-catalog`), then search "document reader" and install `dsh-document-reader`.

**B. Direct install from npm**:

```bash
dsh plugin --profile desktop add dsh-document-reader
```

**C. Direct install from GitHub**:

```bash
dsh plugin --profile desktop add "git+https://github.com/wangjianghu/dsh-document-reader.git"
```

Open the reader from the left sidebar (book icon) and paste an absolute local file path, or use the file browser.

## 中文说明

DSH 文档阅读器:在独立面板阅读本地 PDF、DOCX、EPUB、HTML、Markdown、文本、图片与 Office 演示稿/表格(经 DSH 自带 LibreOffice 引擎转 PDF,按内容缓存)。支持大纲导航、文内搜索、编辑保存、重命名、最近文件、滚动位置记忆;选中文字可引用到对话、复制、文内搜索、翻译——三引擎(必应 / Google / DSH 模型)全部内置,⚙ 设置中切换;并提供 `doc_reader` 对话工具、当前文档上下文注入与 `/doc` 命令,让助手直接读你的文档。

安装:插件 → 发现,添加收录本插件的索引源后搜索安装;或 `dsh plugin --profile desktop add dsh-document-reader`。打开方式:左侧栏书本图标,粘贴本地文件绝对路径回车。

## Repository layout

```
├── index.js               # Host half: HTTP routes, extraction engine, tool/context/command services
├── client.js              # Client half: reader panel, all views, selection bar, translate overlay
├── client.vendor.js       # Lazy chunk: markdown-it + jszip + docx-preview
├── client.pdfjs.js        # Lazy chunk: pdfjs-dist + worker
├── cordis.patch.yml       # Loader rows (reader + translator service)
├── locale/                # Plugin-manager display metadata (en / zh)
├── tools/                 # Regression suites (host / client / smoke) + vendor build
└── index.json             # DSH plugin-market index (format 1), self-hosted
```

## Development

The reader is dual-half (Host services + Client slots). Iterate by linking the package directory:

```bash
dsh plugin --profile desktop add "link:$(pwd)"
```

Host-half changes need a plugin reload; client-half changes a page refresh.

### Tests · 测试

Three regression suites live in `tools/` (run in CI):

```bash
node tools/host-test.mjs        # Host half
mkdir -p /tmp/vendor && cd /tmp/vendor && npm init -y && npm i jsdom@24 react@18 react-dom@18 jszip
node "$OLDPWD/tools/client-test.mjs"   # client half, needs the vendor env above
node "$OLDPWD/tools/smoke-test.mjs"    # end-to-end panel smoke
```

`tools/build-vendor.mjs` rebuilds the lazy client chunks (`client.vendor.js` / `client.pdfjs.js`).

## License & attribution

MIT — see [LICENSE](LICENSE). Bundled third-party libraries are listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

This project started as a reimplementation of the feature set of the VSCode extension `vscode-doc-reader` (publisher *DocReader*). No original code is included — every line in this repository was written from scratch for DSH (verified: zero verbatim overlap with the original distribution).
