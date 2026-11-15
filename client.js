// Client half of the DSH doc-reader plugin (v2).
// Registers the "doc-reader" main panel and its sidebar entry; renders local
// PDF / DOCX / Markdown / text / image files fetched from the Host routes.
//
// v2 adds (see docs/对照分析.md):
// - PDF continuous scroll + lazy page rendering + text-layer search + fit-width
// - DOCX full render options + page synthesis + style.zoom + page controls
// - Markdown: breaks, slug TOC, external-link guard, intra-doc links
// - MD/text in-document search with n/m navigation
// - Image: 100% reset / fit-width / rotation-aware fit / stage sizing
// - Structured per-kind position restore, rename, reveal, settings overlay
window.__ModuleLoader__.load({
	id: 'dsh-document-reader',
	factory(require) {
		const React = require('react');
		const { useState, useEffect, useRef, useCallback, useMemo } = React;
		const h = React.createElement;
		// Bump on every client release. Shown in ⚙ settings, set as data-attr on the
		// panel root and logged at load — a stale cached bundle (the webview can serve
		// an old client.js across refreshes) is then distinguishable from a code bug
		// in one glance instead of a blind debugging round.
		const CLIENT_VERSION = '1.0.3';
		try { console.info(`[doc-reader] client v${CLIENT_VERSION}`); } catch { /* console unavailable */ }

		const ROUTE = '/doc-reader/dsh-document-reader';
		const FILE_URL = (path) => `${ROUTE}/file/${encodeURIComponent(path)}`;
		const LIST_URL = (dir) => `${ROUTE}/list${dir ? `?path=${encodeURIComponent(dir)}` : ''}`;
		const RENAME_URL = `${ROUTE}/rename`;
		const REVEAL_URL = (path) => `${ROUTE}/reveal?path=${encodeURIComponent(path)}`;
		const ACTIVE_URL = `${ROUTE}/active`;
		const CONFIG_URL = `${ROUTE}/config`;
		const TRANSLATE_URL = `${ROUTE}/translate`;
		const EVENTS_URL = (path) => `${ROUTE}/events${path ? `?path=${encodeURIComponent(path)}` : ''}`;

		const MD_EXT = ['md', 'markdown'];
		const TXT_EXT = ['txt', 'log', 'json', 'yaml', 'yml', 'csv', 'tsv', 'xml', 'ini', 'conf', 'toml'];
		const IMG_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif', 'jfif'];
		const OFFICE_EXT = ['pptx', 'xlsx', 'ppt', 'xls', 'doc'];
		const kindOf = (path) => {
			const name = path.slice(path.lastIndexOf('/') + 1);
			const dot = name.lastIndexOf('.');
			if (dot <= 0) return null; // no extension, or a dotfile like ".md" (Host extname treats those as extensionless)
			const ext = name.slice(dot + 1).toLowerCase();
			if (MD_EXT.includes(ext)) return 'markdown';
			if (TXT_EXT.includes(ext)) return 'text';
			if (IMG_EXT.includes(ext)) return 'image';
			if (OFFICE_EXT.includes(ext)) return 'office';
			if (ext === 'pdf') return 'pdf';
			if (ext === 'docx') return 'docx';
			if (ext === 'epub') return 'epub';
			if (ext === 'html' || ext === 'htm') return 'html';
			return null;
		};

		// ---------- persistence ----------
		const LS = {
			recent: 'dsh-doc-reader:recent',
			settings: 'dsh-doc-reader:settings',
			pos: (path) => `dsh-doc-reader:pos:${path}`,
			draft: (path) => `dsh-doc-reader:draft:${path}`,
		};
		function readJson(key, fallback) {
			try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
		}
		function writeJson(key, value) {
			try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* full */ }
		}
		const DEFAULT_SETTINGS = { fontSize: 15, lineHeight: 1.7, recentLimit: 20, pdfTextLayer: true, docxBreakPages: true, lang: 'auto', translateTarget: 'zh-Hans', translateEngine: 'bing', translateProvider: '', translateModel: '', translateGoogleEndpoint: '' };
		const getSettings = () => ({ ...DEFAULT_SETTINGS, ...readJson(LS.settings, {}) });
		const getPos = (path) => readJson(LS.pos(path), null);
		const savePos = (path, pos) => writeJson(LS.pos(path), pos);
		const removePos = (path) => { try { localStorage.removeItem(LS.pos(path)); } catch { /* storage disabled */ } };
		const removeDraft = (path) => { try { localStorage.removeItem(LS.draft(path)); } catch { /* storage disabled */ } };
		function pushRecent(path, limit) {
			const kind = kindOf(path);
			const prev = readJson(LS.recent, []);
			const next = [{ path, kind, at: Date.now() }, ...prev.filter((e) => e.path !== path)]
				.slice(0, Math.max(5, Math.min(200, limit)));
			// drop the position record of entries evicted from the recent list
			for (const e of prev) if (!next.some((n) => n.path === e.path)) { removePos(e.path); removeDraft(e.path); }
			writeJson(LS.recent, next);
		}

		// ---------- lazy vendor chunks ----------
		// A rejected promise must NOT stay cached: one transient failure would
		// otherwise permanently break every md/docx/pdf open until page reload.
		let vendorPromise;
		function loadVendor() {
			vendorPromise ??= require.async('./client.vendor.js').catch((error) => { vendorPromise = null; throw error; });
			return vendorPromise;
		}
		let pdfjsPromise;
		function loadPdfjs() {
			pdfjsPromise ??= require.async('./client.pdfjs.js').then((m) => {
				const lib = m.pdfjsLib;
				if (!lib.GlobalWorkerOptions.workerSrc && m.workerText) {
					lib.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([m.workerText], { type: 'text/javascript' }));
				}
				return lib;
			}).catch((error) => { pdfjsPromise = null; throw error; });
			return pdfjsPromise;
		}

		/** Decode text bytes: strict UTF-8 first, then common CJK legacy
		 * encodings (TextDecoder ships them in Chromium), else lenient UTF-8.
		 * A leading BOM is stripped. */
		function decodeText(buf) {
			const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
			const utf8Strict = () => new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
			for (const attempt of [utf8Strict, () => new TextDecoder('gbk').decode(bytes), () => new TextDecoder('big5').decode(bytes), () => new TextDecoder('shift_jis').decode(bytes)]) {
				try {
					const out = attempt();
					if (typeof out === 'string') return out.replace(/^\uFEFF/u, '');
				} catch { /* try next encoding */ }
			}
			return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/u, '');
		}

		async function fetchFile(path, as, signal) {
			const res = await fetch(FILE_URL(path), { signal });
			if (!res.ok) {
				const detail = await res.json().catch(() => ({ error: res.statusText }));
				throw new Error(detail.error || `${res.status}`);
			}
			if (as === 'text') return decodeText(await res.arrayBuffer());
			return res.arrayBuffer();
		}

		const joinDir = (base, src) => {
			const clean = src.split('?')[0].split('#')[0];
			if (/^https?:/iu.test(clean) || clean.startsWith('data:') || clean.startsWith('mailto:')) return null;
			if (clean.startsWith('/')) return clean;
			const parts = base.split('/');
			for (const seg of clean.split('/')) {
				if (seg === '' || seg === '.') continue;
				if (seg === '..') parts.pop();
				else parts.push(seg);
			}
			return parts.join('/') || '/';
		};

		/** VSCode-extension-style heading slug: strip punctuation, spaces to '-', dedupe. */
		function slugify(text, occurrences) {
			const base = text.trim().toLowerCase()
				.replace(/[`~!@#$%^&*()+={}\[\]|\\:;"'<>,.?/]/g, '')
				.replace(/\s+/g, '-')
				.replace(/-+/g, '-')
				.replace(/^-|-$/g, '') || 'section';
			const count = occurrences.get(base) ?? 0;
			occurrences.set(base, count + 1);
			return count === 0 ? base : `${base}-${count}`;
		}

		const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

		// ---------- styles ----------
		const CSS = `
.dr-panel{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font,inherit)}
.dr-toolbar{display:flex;align-items:center;gap:8px;padding:7px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);flex:none;flex-wrap:wrap}
.dr-logo{display:flex;align-items:center;gap:6px;font-size:13px;font-weight:600;white-space:nowrap}
.dr-logo svg{width:16px;height:16px}
.dr-rename{display:flex;align-items:center;gap:4px;font-size:13px;font-weight:600;min-width:0;max-width:34%}
.dr-rename-btn{display:inline-flex;align-items:center;gap:5px;background:none;border:none;padding:3px 6px;border-radius:6px;color:var(--dsw-alias-label-primary);cursor:pointer;font:inherit;max-width:100%;position:relative;z-index:1}
.dr-rename-btn:hover,.dr-rename-btn:focus-visible{background:var(--dsw-alias-interactive-bg-hover)}
.dr-rename-btn svg{width:12px;height:12px;opacity:.45;flex:none;transition:opacity .12s}
.dr-rename-btn:hover svg{opacity:.9}
.dr-rename-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-rename-input{font:inherit;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l3);border-radius:6px;padding:3px 8px;min-width:120px;outline:none;width:100%}
.dr-path{flex:1;min-width:160px;box-sizing:border-box;height:30px;padding:0 10px;font-size:12px;font-family:var(--dsw-font-mono,monospace);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);outline:none}
.dr-path:focus{border-color:var(--dsw-alias-border-l3)}
.dr-path::placeholder{color:var(--dsw-alias-label-tertiary)}
.dr-btn{height:28px;padding:0 10px;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap;font-family:inherit}
.dr-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dr-btn[aria-pressed="true"]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dr-btn:disabled{opacity:.45;cursor:default}
.dr-btn--icon{width:28px;padding:0;justify-content:center}
.dr-selbar{position:fixed;transform:translate(-50%,-100%);margin-top:-6px;display:inline-flex;align-items:center;gap:1px;height:28px;padding:2px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);box-shadow:0 2px 10px rgba(0,0,0,.18);z-index:70}
.dr-selbar button{width:26px;height:24px;display:inline-flex;align-items:center;justify-content:center;background:none;border:none;border-radius:6px;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}
.dr-selbar button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dr-selbar svg{width:13px;height:13px}
.dr-ctxmenu{position:fixed;min-width:168px;padding:4px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);box-shadow:0 6px 24px rgba(0,0,0,.22);z-index:75;display:flex;flex-direction:column}
.dr-ctxmenu button{display:flex;align-items:center;gap:8px;padding:6px 10px;border:none;background:none;color:var(--dsw-alias-label-primary);font-size:12px;text-align:left;cursor:pointer;border-radius:5px;font-family:inherit}
.dr-ctxmenu button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dr-ctxmenu button:disabled{opacity:.4;cursor:default}
.dr-external{display:flex;align-items:center;gap:8px;padding:5px 12px;border-bottom:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);flex:none;font-size:12px}
.dr-external-msg{flex:1;min-width:0;color:var(--dsw-alias-label-primary)}
.dr-body{flex:1;min-height:0;display:flex}
.dr-side{width:260px;flex:none;min-height:0;min-width:0;display:flex;flex-direction:column;border-right:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.dr-side-hidden{display:none}
.dr-side-tabs{display:flex;gap:2px;padding:6px 8px 0;flex:none}
.dr-side-tab{flex:1;height:26px;font-size:12px;color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-bottom:1.5px solid transparent;cursor:pointer;font-family:inherit}
.dr-side-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-label-primary)}
.dr-side-scroll{flex:1;min-height:0;overflow-x:hidden;overflow-y:auto;padding:4px 0 12px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}
.dr-crumbs{display:flex;flex-wrap:wrap;gap:2px;padding:6px 10px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary);flex:none}
.dr-crumb{background:none;border:none;padding:2px 4px;font-size:11px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-family:inherit;border-radius:4px}
.dr-crumb:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dr-row{display:flex;width:100%;max-width:100%;box-sizing:border-box;align-items:center;gap:7px;padding:5px 10px;font-size:12px;color:var(--dsw-alias-label-primary);background:none;border:none;cursor:pointer;text-align:left;font-family:inherit;position:relative;overflow:hidden}
.dr-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dr-row svg{width:14px;height:14px;flex:none;opacity:.75}
.dr-row>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-row:hover>span{padding-right:6px}
.dr-row small{margin-left:auto;color:var(--dsw-alias-label-tertiary);font-size:10px;flex:none;white-space:nowrap;padding-left:6px}
.dr-row:hover>small{visibility:hidden}
.dr-toc-expand{position:absolute;top:8px;left:8px;z-index:5;width:22px;height:22px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:12px;display:flex;align-items:center;justify-content:center;padding:0;box-shadow:0 1px 4px rgba(0,0,0,.12)}
.dr-toc-expand:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dr-browse{width:min(560px,86vw);height:min(520px,80vh);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden}
.dr-browse header{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l2);font-size:13px;font-weight:600;flex:none}
.dr-browse .dr-crumbs{padding:8px 12px 4px}
.dr-browse .dr-side-scroll{flex:1;min-height:0;padding:4px 0 8px}
.dr-browse footer{display:flex;justify-content:flex-end;gap:8px;padding:8px 12px;border-top:.5px solid var(--dsw-alias-border-l2);flex:none}
.dr-side-head{padding:6px 10px;flex:none;display:flex;align-items:center;justify-content:space-between;gap:8px}
.dr-side-title{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dr-row-actions{position:absolute;right:2px;top:50%;transform:translateY(-50%);display:none;gap:1px;background:var(--dsw-alias-bg-layer-3);border:.5px solid var(--dsw-alias-border-l2);padding:1px 2px;border-radius:6px;z-index:2}
.dr-row:hover .dr-row-actions{display:inline-flex}
.dr-row:hover>small{display:none}
.dr-row-actions button{background:none;border:none;padding:2px 6px;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px;border-radius:4px;display:inline-flex;align-items:center;line-height:1;min-width:22px;justify-content:center}
.dr-row-actions button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dr-tip{position:fixed;transform:translate(-50%,-100%);margin-top:-6px;background:var(--dsw-alias-tooltip-bg,#2c2c2e);color:var(--dsw-alias-tooltip-label,#fff);border:none;border-radius:7px;padding:4px 9px;font-size:12px;line-height:18px;white-space:nowrap;pointer-events:none;/* max int: the tooltip lives at document.body but nothing in the app may stack above it (app bubbles sit at 100, toasts 1100) */z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.28)}
.dr-tip--below{transform:translate(-50%,0)!important;margin-top:0!important}
.dr-tip--side-l{transform:translate(-100%,-50%)!important;margin-top:0!important}
.dr-tip--side-r{transform:translate(0,-50%)!important;margin-top:0!important}
.dr-empty-side{padding:16px 12px;font-size:12px;color:var(--dsw-alias-label-tertiary);line-height:1.6}
.dr-content{flex:1;min-width:0;min-height:0;position:relative;display:flex;flex-direction:column}
.dr-viewbar{display:flex;align-items:center;gap:6px;padding:5px 12px;border-bottom:.5px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap;min-height:34px}
.dr-viewbar input[type="search"]{width:150px;height:24px;padding:0 8px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none}
.dr-count{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:34px;text-align:center}
.dr-badge{font-size:11px;color:var(--dsw-alias-label-tertiary);min-width:40px;text-align:center}
.dr-stage{flex:1;min-height:0;display:flex;position:relative}
.dr-scroll{flex:1;min-width:0;min-height:0;overflow:auto;position:relative;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}
.dr-toc{width:200px;flex:none;border-right:.5px solid var(--dsw-alias-border-l1);overflow:auto;font-size:12px;padding:8px 6px}
.dr-toc-title{font-size:11px;color:var(--dsw-alias-label-tertiary);padding:0 8px 6px}
.dr-toc button{display:block;width:100%;text-align:left;background:none;border:none;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:3px 8px;font-size:12px;font-family:inherit;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border-radius:4px}
.dr-toc button:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dr-toc button.active{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dr-status{flex:none;display:flex;align-items:center;padding:3px 12px;min-height:22px;font-size:11px;color:var(--dsw-alias-label-tertiary);border-top:.5px solid var(--dsw-alias-border-l1)}
.dr-error{margin:auto;padding:24px;font-size:13px;color:var(--dsw-alias-label-secondary);text-align:center;line-height:1.8}
.dr-empty{margin:auto;padding:24px;display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center}
.dr-empty svg{width:44px;height:44px;opacity:.5}
.dr-load{margin:auto;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dr-md{flex:1;min-width:0;padding:16px 26px 60px;font-size:15px;line-height:var(--dr-line-height,1.7);white-space:normal;overflow-wrap:break-word}
.dr-md h1,.dr-md h2,.dr-md h3,.dr-md h4,.dr-md h5,.dr-md h6{line-height:1.35;margin:1.2em 0 .5em}
.dr-md h1{font-size:1.55em}.dr-md h2{font-size:1.3em}.dr-md h3{font-size:1.12em}.dr-md h4{font-size:1em}
.dr-md p{margin:.65em 0}
.dr-md pre{background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:12px;overflow:auto;font-family:var(--dsw-font-mono,monospace);font-size:12.5px;line-height:1.6}
.dr-md code{font-family:var(--dsw-font-mono,monospace);font-size:.92em;background:var(--dsw-alias-bg-layer-2);padding:1px 5px;border-radius:4px}
.dr-md pre code{background:none;padding:0}
.dr-md blockquote{margin:.8em 0;padding:2px 14px;border-left:3px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-secondary)}
.dr-md img{max-width:100%;border-radius:6px}
.dr-md table{border-collapse:collapse;margin:.8em 0}
.dr-md th,.dr-md td{border:.5px solid var(--dsw-alias-border-l2);padding:5px 10px;font-size:.95em}
.dr-md th{background:var(--dsw-alias-bg-layer-2)}
.dr-md a{color:var(--dsw-alias-label-accent,var(--dsw-alias-label-primary));cursor:pointer}
.dr-md hr{border:none;border-top:.5px solid var(--dsw-alias-border-l2);margin:1.6em 0}
.dr-text{padding:14px 18px 60px;font-family:var(--dsw-font-mono,monospace);white-space:pre-wrap;word-break:break-word;line-height:var(--dr-line-height,1.7)}
mark.dr-mark{background:color-mix(in srgb,var(--dsw-alias-label-accent,#e6b800) 38%,transparent);color:inherit;border-radius:2px;padding:0 1px}
mark.dr-mark.active{background:var(--dsw-alias-label-accent,#e6b800);color:#20222a}
.dr-pdf-doc{display:flex;flex-direction:column;align-items:center;gap:14px;padding:18px 8px 44px}
.dr-pdf-shell{position:relative;background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.28);border-radius:2px;min-height:40px;min-width:40px}
.dr-pdf-shell canvas{display:block;border-radius:2px}
.dr-pdf-shell[data-error]::after{content:attr(data-error);position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:12px;color:#b44;background:#fff;padding:12px;text-align:center}
.dr-docx-scroll{padding:18px 8px 44px}
.dr-docx-scroll .docx-wrapper{background:transparent;box-shadow:none;padding:0}
.dr-docx-inner{background:#fff;box-shadow:0 4px 18px rgba(0,0,0,.28);border-radius:2px;width:max-content;min-width:600px}
.dr-docx-anchor{position:absolute}
.dr-image-host{display:flex;min-height:100%;padding:24px;box-sizing:border-box}
.dr-image-stage{position:relative;padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2);flex:none;margin:auto}
.dr-image-stage img{display:block;transform-origin:0 0;user-select:none;-webkit-user-drag:none}
.dr-editor-shell{display:flex;height:100%;min-height:0;font-family:var(--dsw-font-mono,monospace);font-size:13px;line-height:1.7}
.dr-editor-lines{flex:none;width:46px;margin:0;padding:12px 8px 40px 0;text-align:right;color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-bg-layer-2);border-right:.5px solid var(--dsw-alias-border-l1);overflow:hidden;white-space:pre;user-select:none}
.dr-editor{flex:1;min-width:0;height:100%;box-sizing:border-box;margin:0;padding:12px 16px 40px;border:none;outline:none;resize:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;white-space:pre-wrap;word-break:break-word;overflow:auto;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2}
.dr-editor:disabled{opacity:.6}
.dr-toc-head{display:flex;align-items:center;justify-content:space-between;padding:0 4px 6px 8px}
.dr-toc-collapse{background:none;border:none;color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:2px 6px;border-radius:4px;font-size:12px;display:inline-flex;align-items:center}
.dr-toc-collapse:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.dr-overlay{position:fixed;inset:0;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;z-index:60}
.dr-settings{width:340px;background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l3);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:14px;box-shadow:0 12px 40px rgba(0,0,0,.3)}
.dr-settings-title{margin:0;font-size:14px;font-weight:600}
.dr-set-row{display:grid;grid-template-columns:1fr auto;align-items:center;gap:10px;font-size:12.5px;color:var(--dsw-alias-label-primary)}
.dr-set-row>span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dr-set-row input[type="number"]{grid-column:2;width:76px;height:26px;box-sizing:border-box;padding:0 8px;font-size:12px;font-family:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:.5px solid var(--dsw-alias-border-l2);border-radius:6px;outline:none;text-align:right;-moz-appearance:textfield;appearance:textfield}
.dr-set-row input[type="number"]::-webkit-outer-spin-button,.dr-set-row input[type="number"]::-webkit-inner-spin-button{-webkit-appearance:none;margin:0}
.dr-set-row input[type="number"]:focus{border-color:var(--dsw-alias-border-l3)}
.dr-set-row .dr-switch{grid-column:2;display:flex;align-items:center}
.dr-set-row input[type="checkbox"]{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-label-primary)}
.dr-settings-actions{display:flex;justify-content:flex-end;gap:8px}
`;

		// ---------- icons ----------
		const Glyph = {
			file: (s) => h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true },
				h('path', { fill: 'currentColor', d: 'M4 1.5A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8A1.5 1.5 0 0 0 13.5 13V5.207L9.793 1.5H4Zm5.5.707L12.793 5.5H9.5V2.207Z' })),
			dir: (s) => h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true },
				h('path', { fill: 'currentColor', d: 'M1.5 3A1.5 1.5 0 0 1 3 1.5h3.086a1.5 1.5 0 0 1 1.06.44l.915.914a.5.5 0 0 0 .353.146H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V3Z' })),
			pencil: () => h('svg', { viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round' },
				h('path', { d: 'm11.8 2.7 1.5 1.5a1.2 1.2 0 0 1 0 1.7L6.2 13H3v-3.2l7.1-7.1a1.2 1.2 0 0 1 1.7 0Z' }),
				h('path', { d: 'm9.6 3.9 2.5 2.5' })),
			quote: (s) => h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true, fill: 'currentColor' },
				h('path', { d: 'M4 3h2.2v7.5a2.5 2.5 0 0 1-2.5 2.5H3V11h.7a.7.7 0 0 0 .7-.7V3Zm5.8 0H12v7.5a2.5 2.5 0 0 1-2.5 2.5H8.8V11h.7a.7.7 0 0 0 .7-.7V3Z' })),
			copy: (s) => h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round' },
				h('rect', { x: 5.5, y: 5.5, width: 8, height: 8, rx: 1.5 }),
				h('path', { d: 'M10.5 3.5v-.5A1.5 1.5 0 0 0 9 .5H3.5A1.5 1.5 0 0 0 2 2v6a1.5 1.5 0 0 0 1.5 1.5H4', transform: 'translate(0 1)' })),
			search: (s) => h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' },
				h('circle', { cx: 7, cy: 7, r: 4.2 }),
				h('line', { x1: 10.2, y1: 10.2, x2: 14, y2: 14 })),
			translateG: (s) => h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true },
				h('text', { x: 1.5, y: 12, fontSize: 9, fontWeight: 700, fill: 'currentColor', fontFamily: 'Georgia, serif' }, 'A'),
				h('text', { x: 8.5, y: 12, fontSize: 9, fontWeight: 700, fill: 'currentColor', fontFamily: 'inherit' }, '文')),
			sliders: (s) => h('svg', { viewBox: '0 0 24 24', width: s, height: s, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' },
				h('line', { x1: 4, y1: 21, x2: 4, y2: 14 }), h('line', { x1: 4, y1: 10, x2: 4, y2: 3 }),
				h('line', { x1: 12, y1: 21, x2: 12, y2: 12 }), h('line', { x1: 12, y1: 8, x2: 12, y2: 3 }),
				h('line', { x1: 20, y1: 21, x2: 20, y2: 16 }), h('line', { x1: 20, y1: 12, x2: 20, y2: 3 }),
				h('line', { x1: 1, y1: 14, x2: 7, y2: 14 }), h('line', { x1: 9, y1: 8, x2: 15, y2: 8 }),
				h('line', { x1: 17, y1: 16, x2: 23, y2: 16 })),
			folder: (s) => h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true }, h('path', { fill: 'currentColor', d: 'M1.5 3A1.5 1.5 0 0 1 3 1.5h3.086a1.5 1.5 0 0 1 1.06.44l.915.914a.5.5 0 0 0 .353.146H13A1.5 1.5 0 0 1 14.5 4.5v8A1.5 1.5 0 0 1 13 14H3a1.5 1.5 0 0 1-1.5-1.5V3Z' })),
			sidebar: (s) => h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true, fill: 'none', stroke: 'currentColor', strokeWidth: 1.3 }, h('rect', { x: 1.8, y: 2.5, width: 12.4, height: 11, rx: 1.6 }), h('line', { x1: 5.6, y1: 2.5, x2: 5.6, y2: 13.5 })) ,
			logo: (s) => h('svg', { viewBox: '0 0 64 64', width: s, height: s, 'aria-hidden': true },
				h('rect', { x: 6, y: 10, width: 40, height: 44, rx: 4, fill: '#4a8fd4' }),
				h('rect', { x: 12, y: 16, width: 30, height: 36, rx: 2, fill: '#f4f8fc' }),
				h('rect', { x: 17, y: 22, width: 20, height: 2.6, rx: 1.3, fill: '#9db8d2' }),
				h('rect', { x: 17, y: 29, width: 20, height: 2.6, rx: 1.3, fill: '#9db8d2' }),
				h('rect', { x: 17, y: 36, width: 12, height: 2.6, rx: 1.3, fill: '#9db8d2' }),
				h('path', { d: 'M14 10c4-3 9-3 13 0v44c-4-3-9-3-13 0z', fill: '#3a76b0', opacity: .9 }),
				h('circle', { cx: 46, cy: 42, r: 11, fill: '#fff', stroke: '#2f5f8f', 'stroke-width': 3 }),
				h('line', { x1: 54, y1: 50, x2: 60, y2: 56, stroke: '#2f5f8f', 'stroke-width': 4, 'stroke-linecap': 'round' }),
				h('circle', { cx: 46, cy: 42, r: 6, fill: 'none', stroke: '#4a8fd4', 'stroke-width': 2.4 })),
		};
		const kindGlyph = (kind, s = 14) => {
			if (kind === 'pdf') return h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true }, h('path', { fill: '#c0504d', d: 'M4 1.5A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8A1.5 1.5 0 0 0 13.5 13V5.2L9.8 1.5H4Zm6 .7L12.8 5.5H10V2.2ZM5.6 8.2h1c.2 1.4.5 2.4.9 3 .2-1.2.3-2.4.4-3.7l1.2-.1c-.1 1.9-.4 3.5-.8 4.9-.3 1.1-.9 1.8-1.7 2.1l-.7-1c.5-.2.9-.6 1.1-1.1-.5-.8-.9-2-1.2-3.4l-.2-.7Z' }));
			if (kind === 'markdown') return h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true }, h('path', { fill: '#4a7db5', d: 'M2.5 4h11A1.5 1.5 0 0 1 15 5.5v5A1.5 1.5 0 0 1 13.5 12h-11A1.5 1.5 0 0 1 1 10.5v-5A1.5 1.5 0 0 1 2.5 4Zm1.2 6h1.4V7.2l1.3 1.6 1.3-1.6V10h1.4V6H8.1L6.4 8 4.7 6H3.7v4Zm7.5 0h1.5V6h-1.5L10 7.5 10.7 8.6 11.2 8v2Z' }));
			if (kind === 'docx') return h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true }, h('path', { fill: '#3a6ea5', d: 'M9 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V6L9 1Zm0 1.7L12.4 6H9V2.7ZM5.2 11.8c.8-.5 1.3-1.2 1.7-2.2.2.9.5 1.7.9 2.3l-.9.6c-.2-.4-.4-.9-.6-1.5-.3.6-.6 1.1-1 1.5l-.9-.4.8-1.9H4.4v-.9h1.7L5.2 7l.8-.3.4 1.2h.8l.4-1.2.8.3-.4 1.2h1.4v.9H8.7l.7 1.8c.3-.5.5-1 .7-1.6l.9.5c-.3.7-.6 1.3-1 1.8.4.3.8.5 1.3.6l-.5 1c-.7-.2-1.3-.5-1.8-1-.5.4-1.1.7-1.8.9l-.4-.9Z' }));
			if (kind === 'image') return h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true }, h('path', { fill: '#5b8c5a', d: 'M2.5 3h11A1.5 1.5 0 0 1 15 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 1 11.5v-7A1.5 1.5 0 0 1 2.5 3Zm0 1.5v5.1l2.6-2.6 2 2L9.8 6l3.7 3.7v-5a.1.1 0 0 0-.1-.2H2.6a.1.1 0 0 0-.1.2ZM5.5 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z' }));
			if (kind === 'office') return h('svg', { viewBox: '0 0 16 16', width: s, height: s, 'aria-hidden': true },
				h('rect', { fill: '#d9730d', rx: 2.5, x: 1, y: 1, width: 14, height: 14 }),
				h('path', { fill: '#fff', d: 'M3.5 5.5h4.4v1.2H6.6v4.3H5V6.7H3.5v-1.2Zm5.6 0h1.5l1 1.9 1-1.9H14l-1.7 3 1.8 3.4h-1.6l-1.1-2-1.1 2H7.9L9.7 8.6 8 5.5Z' }));
			return Glyph.file(s);
		};

		// ---------- shared bits ----------
		const Btn = ({ title, onClick, disabled, pressed, children, icon, instantTip, ...rest }) => h('button', {
			className: `dr-btn${icon ? ' dr-btn--icon' : ''}`,
			title: instantTip ? undefined : title, // instant tooltip replaces the delayed native one
			'aria-label': title, 'aria-pressed': pressed,
			...rest, onClick, disabled,
		}, children);

		/** Instant hover tooltip (shared). Native `title` has a ~1s browser delay,
		 * which reads as "broken" on small icon buttons — render a fixed-position
		 * div instead, styled with the platform's dark tooltip tokens (same look
		 * as the app's own bubbles: high contrast, reads as a floating overlay).
		 * The div is appended directly to document.body (imperative DOM, no
		 * react-dom dependency) at max z-index: app-shell ancestors of the panel
		 * (transforms/containment in the layout) turn `position:fixed` into
		 * container-relative coordinates and stack it under sibling layers — at
		 * body level it is true-viewport and above every in-panel layer.
		 * `anchor`: 'above' (default) | 'below' (selection bar over document
		 * content) | 'left' | 'right' (beside the button, vertically centered —
		 * the pattern the platform's own side-panel toggles use; the toolbar's
		 * right-side icons anchor left, the left-most rename button anchors
		 * right). After mounting, the bubble is clamped into the viewport, and
		 * above-placement is pushed down when there is no headroom. mouseover/out
		 * (bubbling) delegate reliably everywhere; the relatedTarget guard skips
		 * moves between the button and its own svg glyph so the tooltip never
		 * flickers. */
		function useTip(anchor = 'above') {
			const [tip, setTip] = useState(null); // { text, x, y } viewport coords
			// `xFrom` (optional, side anchors): (el) => element whose edge replaces
			// the hovered element's for the X coordinate — the toolbar's right-side
			// icons pass the path input so ALL their bubbles share ONE fixed slot:
			// the bubble's right border sits EXACTLY on the input's right border,
			// whichever of the three icons is hovered. A detached/zero-size anchor
			// (mid-remount hover) falls back to an 8px gap beside the hovered
			// element, and callers back the ref with a live DOM re-query.
			const place = (el, text, xFrom) => {
				const r = el.getBoundingClientRect();
				let xr = null;
				try { const t = xFrom?.(el); const tr = t?.getBoundingClientRect?.(); if (tr && tr.width > 0) xr = tr; } catch { /* anchor unavailable */ }
				const x = anchor === 'left' ? (xr ? xr.right : r.left - 8) : anchor === 'right' ? (xr ? xr.left : r.right + 8) : r.left + r.width / 2;
				const y = (anchor === 'left' || anchor === 'right') ? r.top + r.height / 2 : anchor === 'below' ? r.bottom + 6 : r.top;
				// dedupe: mouseover re-fires when the cursor crosses the button's
				// own svg glyph (bubbling) — an unchanged {text,x,y} must not
				// re-render, or the tooltip element is destroyed and recreated on
				// every internal move (DOM churn + visible flicker).
				setTip((prev) => (prev && prev.text === text && prev.x === x && prev.y === y) ? prev : { text, x, y });
			};
			const hoverProps = (text, xFrom) => ({
				onMouseOver: (ev) => place(ev.currentTarget, text, xFrom),
				onMouseOut: (ev) => { if (!ev.currentTarget.contains(ev.relatedTarget)) setTip(null); },
				onFocus: (ev) => place(ev.currentTarget, text, xFrom),
				onBlur: () => setTip(null),
			});
			useEffect(() => {
				if (!tip) return undefined;
				const variant = { below: 'dr-tip--below', left: 'dr-tip--side-l', right: 'dr-tip--side-r' }[anchor] ?? '';
				const el = document.createElement('div');
				el.className = `dr-tip${variant ? ` ${variant}` : ''}`;
				el.style.left = `${tip.x}px`;
				el.style.top = `${tip.y}px`;
				el.textContent = tip.text;
				document.body.appendChild(el);
				// clamp into the viewport AFTER mounting (needs real metrics).
				// anchor-aware: for side-l `x` is the bubble's RIGHT edge (the
				// shared slot line) — only the LEFT edge may need protecting, so
				// max-x is vw-4, NOT vw-w-4 (the old form pulled long-label
				// bubbles off the slot line whenever the panel sat near the
				// window's right edge, breaking the right-border alignment).
				// side-r's x is the LEFT edge; centered anchors are midpoints.
				const w = el.offsetWidth, hh = el.offsetHeight;
				const vw = document.documentElement?.clientWidth || window.innerWidth || 0;
				if (w && vw) {
					const minX = anchor === 'left' ? w + 4 : anchor === 'right' ? 4 : w / 2 + 4;
					const maxX = Math.max(minX, anchor === 'left' ? vw - 4 : anchor === 'right' ? vw - w - 4 : vw - w / 2 - 4);
					const x = Math.min(Math.max(tip.x, minX), maxX);
					if (x !== tip.x) el.style.left = `${x}px`;
				}
				if (anchor === 'above' && hh && tip.y - hh - 6 < 4) el.style.top = `${hh + 10}px`;
				return () => { el.remove(); };
			}, [tip, anchor]);
			return { hoverProps, hide: () => setTip(null), node: null };
		}

		function ViewBar({ children }) {
			return h('div', { className: 'dr-viewbar' }, children);
		}

		/** Scroll-position persistence for a scroll container, per path.
		 * `enabled` must be false while the scroll container is not mounted
		 * (loading / edit mode): the container only appears after async content
		 * is ready, so a mount-time-only effect would bind to nothing. */
		function useScrollRestore(path, scrollRef, extra, enabled = true) {
			const extraRef = useRef(extra);
			extraRef.current = extra;
			useEffect(() => {
				if (!enabled) return undefined;
				const el = scrollRef.current;
				if (!el) return undefined;
				const saved = getPos(path);
				if (saved && typeof saved.scrollTop === 'number') {
					requestAnimationFrame(() => { el.scrollTop = saved.scrollTop; });
				}
				let timer;
				const onScroll = () => {
					clearTimeout(timer);
					timer = setTimeout(() => savePos(path, { ...extraRef.current(), scrollTop: Math.round(el.scrollTop) }), 300);
				};
				el.addEventListener('scroll', onScroll, { passive: true });
				return () => {
					clearTimeout(timer);
					el.removeEventListener('scroll', onScroll);
					// flush the very last position instead of losing the final <300ms —
					// but never persist a zero from an already-emptied container
					if (el.scrollHeight > el.clientHeight + 50) {
						savePos(path, { ...extraRef.current(), scrollTop: Math.round(el.scrollTop) });
					}
				};
			}, [path, enabled]);
		}

		// ---------- DOM search (markdown / text) ----------
		const MAX_MARKS = 5000;
		/**
		 * Installs a TreeWalker highlighter over `contentRef`.
		 * Returns { run(query, dir), clear() } operating on the live DOM.
		 * Callbacks are kept in refs so `run`/`clear` identities are stable —
		 * otherwise a parent re-render re-runs the cleanup and wipes highlights.
		 */
		function useDomSearch(contentRef, onCount, onStatus, t) {
			const marksRef = useRef([]);
			const indexRef = useRef(-1);
			const activeRef = useRef(null);
			const onCountRef = useRef(onCount);
			onCountRef.current = onCount;
			const onStatusRef = useRef(onStatus);
			onStatusRef.current = onStatus;
			const tRef = useRef(t);
			tRef.current = t;
			const setActive = (mark) => {
				if (activeRef.current && activeRef.current.parentNode) activeRef.current.classList.remove('active');
				activeRef.current = mark;
				mark.classList.add('active');
				mark.scrollIntoView({ block: 'center', behavior: 'smooth' });
			};
			const clear = useCallback(() => {
				for (const mark of marksRef.current) {
					const parent = mark.parentNode;
					if (!parent) continue;
					parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
					parent.normalize();
				}
				marksRef.current = [];
				indexRef.current = -1;
				activeRef.current = null;
				onCountRef.current?.(0, -1);
			}, []);
			const run = useCallback((query, dir) => {
				const root = contentRef.current;
				if (!root) return;
				if (marksRef.current.length || indexRef.current >= 0) clear();
				const needle = query.trim();
				if (!needle) return;
				const matcher = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
				const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
					acceptNode(node) {
						if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
						const parent = node.parentElement;
						if (!parent || parent.closest('mark.dr-mark,style,script,noscript')) return NodeFilter.FILTER_REJECT;
						return NodeFilter.FILTER_ACCEPT;
					},
				});
				const nodes = [];
				while (walker.nextNode()) nodes.push(walker.currentNode);
				matcher.lastIndex = 0;
				let truncated = false;
				for (const node of nodes) {
					if (truncated) break;
					const value = node.nodeValue;
					if (!value || !matcher.test(value)) continue;
					matcher.lastIndex = 0;
					const fragment = document.createDocumentFragment();
					let last = 0;
					let match;
					while ((match = matcher.exec(value)) !== null) {
						if (marksRef.current.length >= MAX_MARKS) { truncated = true; break; }
						if (match.index > last) fragment.appendChild(document.createTextNode(value.slice(last, match.index)));
						const mark = document.createElement('mark');
						mark.className = 'dr-mark';
						mark.textContent = value.slice(match.index, match.index + match[0].length);
						fragment.appendChild(mark);
						marksRef.current.push(mark);
						last = match.index + match[0].length;
					}
					if (last < value.length) fragment.appendChild(document.createTextNode(value.slice(last)));
					node.parentNode.replaceChild(fragment, node);
				}
				if (truncated) onStatusRef.current?.(tRef.current('panel.searchTruncated'));
				if (marksRef.current.length === 0) { onCountRef.current?.(0, -1); return; }
				const total = marksRef.current.length;
				const focus = (index) => {
					const normalized = ((index % total) + total) % total;
					indexRef.current = normalized;
					setActive(marksRef.current[normalized]);
					onCountRef.current?.(total, normalized);
				};
				focus(dir < 0 ? total - 1 : 0);
			}, []);
			useEffect(() => clear, [clear]);
			return {
				run,
				clear,
				navigate: (dir) => {
					if (marksRef.current.length === 0) return;
					const total = marksRef.current.length;
					const next = indexRef.current < 0 ? 0 : indexRef.current + dir;
					const normalized = ((next % total) + total) % total;
					indexRef.current = normalized;
					setActive(marksRef.current[normalized]);
					onCountRef.current?.(total, normalized);
				},
			};
		}

		function SearchControls({ t, query, setQuery, count, index, onEnter, onPrev, onNext, disabled }) {
			return h(React.Fragment, null,
				h('input', {
					type: 'search', value: query, placeholder: t('panel.search'), disabled,
					onChange: (e) => setQuery(e.target.value),
					onKeyDown: (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); onEnter(e.shiftKey ? -1 : 1); } },
				}),
				h(Btn, { title: t('panel.searchPrev'), onClick: onPrev, disabled: disabled || count === 0 }, '‹'),
				h(Btn, { title: t('panel.searchNext'), onClick: onNext, disabled: disabled || count === 0 }, '›'),
				h('span', { className: 'dr-count' }, count > 0 ? `${index + 1}/${count}` : (query ? '0/0' : '')));
		}

		// ---------- Markdown ----------
		const MD_PLAIN_THRESHOLD = 4 * 1024 * 1024;
		// one shared markdown-it instance; per-document state travels via env
		/** Visual Y of `offset` inside a textarea: mirror its styles in an
		 * offscreen div and measure a marker (soft-wrap accurate). Returns null
		 * when the prefix is too large to mirror. */
		function measureTextareaTop(el, text, offset) {
			if (offset > 256 * 1024) return null;
			const doc = el.ownerDocument;
			const mirror = doc.createElement('div');
			const cs = getComputedStyle(el);
			for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'boxSizing', 'whiteSpace', 'wordWrap', 'overflowWrap', 'wordBreak', 'tabSize', 'width']) {
				mirror.style[prop] = cs[prop];
			}
			mirror.style.position = 'absolute';
			mirror.style.visibility = 'hidden';
			mirror.style.left = '-9999px';
			mirror.style.top = '0';
			mirror.textContent = text.slice(0, offset);
			const mark = doc.createElement('span');
			mark.textContent = '\u200b';
			mirror.appendChild(mark);
			doc.body.appendChild(mirror);
			const top = mark.offsetTop;
			mirror.remove();
			return Number.isFinite(top) ? top : null;
		}

		/** Heading outline straight from the draft text (edit mode): one line per
		 * heading, carrying its character offset for editor jump targets. */
		function extractDraftOutline(text) {
			if (!text) return [];
			const items = [];
			let offset = 0;
			for (const line of text.split('\n')) {
				const match = /^(#{1,6})\s+(.*)$/u.exec(line);
				if (match) items.push({ level: match[1].length, text: match[2].trim(), id: `ln-${offset}`, lineOffset: offset });
				offset += line.length + 1;
				if (items.length >= 300) break; // cap pathological documents
			}
			return items;
		}


		let mdPromise = null;
		function getMarkdownIt() {
			mdPromise ??= loadVendor().then((vendor) => {
				const md = new vendor.MarkdownIt({ html: false, linkify: false, typographer: false, breaks: true });
				const defaultImage = md.renderer.rules.image;
				md.renderer.rules.image = (tokens, idx, options, env, self) => {
					const token = tokens[idx];
					const srcAttr = token.attrGet('src');
					if (srcAttr && env?.dir) {
						const resolved = joinDir(env.dir, srcAttr);
						if (resolved && kindOf(resolved) === 'image') {
							token.attrSet('src', FILE_URL(resolved));
							token.attrSet('loading', 'lazy');
							token.attrSet('decoding', 'async');
						} else {
							// remote/unsupported src: never let the document make network requests
							token.attrSet('src', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=');
						}
					}
					return defaultImage(tokens, idx, options, env, self);
				};
				md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
					const level = Number.parseInt(tokens[idx].tag.slice(1), 10);
					const headingText = (tokens[idx + 1]?.content ?? '').trim();
					const id = slugify(headingText, env?.occurrences ?? new Map());
					tokens[idx].attrSet('id', id);
					if (level >= 1 && level <= 6) env?.outline?.push({ level, text: headingText, id });
					return self.renderToken(tokens, idx, options);
				};
				return md;
			}).catch((error) => { mdPromise = null; throw error; });
			return mdPromise;
		}

		function MarkdownView({ path, settings, t, onStatus, onSidebar, onOpen, sidebar, onEditingChange }) {
			const [state, setState] = useState({ status: 'loading' });
			const [fontSize, setFontSize] = useState(() => {
				const pos = getPos(path);
				return (pos && pos.kind === 'markdown' && typeof pos.fontSize === 'number') ? pos.fontSize : settings.fontSize;
			});
			const [query, setQuery] = useState('');
			const [count, setCount] = useState(0);
			const [index, setIndex] = useState(-1);
			const [renderError, setRenderError] = useState(null);
			const bodyRef = useRef(null);
			const scrollRef = useRef(null);
			const search = useDomSearch(bodyRef, (total, idx) => { setCount(total); setIndex(idx); }, onStatus, t);
			const dir = useMemo(() => path.slice(0, path.lastIndexOf('/')) || '/', [path]);
			const text = state.status === 'ready' ? state.text : null;

			useEffect(() => { let alive = true; setState({ status: 'loading' });
				const controller = new AbortController();
				fetchFile(path, 'text', controller.signal)
					.then((src) => { if (alive) setState({ status: 'ready', text: src }); })
					.catch((e) => { if (alive && e?.name !== 'AbortError') setState({ status: 'error', message: e.message }); });
				return () => { alive = false; controller.abort(); };
			}, [path]);

			// render markdown (reruns after edits save new text)
			const rendered = useMemo(() => {
				if (text === null) return null;
				// giant markdown: markdown-it must parse the whole document; degrade to
				// chunked plain text instead of a multi-second freeze + million-node DOM
				if (text.length > MD_PLAIN_THRESHOLD) return Promise.resolve({ html: null, outline: [], plain: true });
				return getMarkdownIt().then((md) => {
					const outline = [];
					const occurrences = new Map();
					const html = md.render(text, { dir, outline, occurrences });
					return { html, outline };
				});
			}, [text, dir]);
			const [renderedState, setRenderedState] = useState(null);
			useEffect(() => {
				if (rendered === null) { setRenderedState(null); return; }
				let alive = true;
				rendered.then((r) => { if (alive) { setRenderedState(r); setRenderError(null); } })
					.catch((e) => { if (alive) setRenderError(e?.message ?? String(e)); });
				return () => { alive = false; };
			}, [rendered]);

			const outlineModel = useCallback((outline) => ({
				kind: 'outline',
				items: outline,
				go: (id) => bodyRef.current?.querySelector(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
			}), []);
			useEffect(() => {
				if (renderedState) onSidebar(renderedState.outline.length > 0 ? outlineModel(renderedState.outline) : null);
				return () => onSidebar(null);
			}, [renderedState]);

			// link guards: external -> new window; .md relative -> open; anchors -> scroll
			useEffect(() => {
				const root = bodyRef.current;
				if (!root || !renderedState) return;
				const onClick = (event) => {
					const anchor = event.target.closest('a[href]');
					if (!anchor) return;
					const href = anchor.getAttribute('href') || '';
					if (/^javascript:/iu.test(href)) { event.preventDefault(); return; }
					if (/^https?:/iu.test(href)) { event.preventDefault(); window.open(href, '_blank', 'noopener,noreferrer'); return; }
					if (href.startsWith('#')) {
						event.preventDefault();
						let id = href.slice(1);
						try { id = decodeURIComponent(id); } catch { /* keep raw */ }
						root.querySelector(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
						return;
					}
					const resolved = joinDir(dir, href);
					if (resolved && kindOf(resolved)) {
						event.preventDefault();
						onOpen(resolved);
					}
				};
				root.addEventListener('click', onClick);
				return () => root.removeEventListener('click', onClick);
			}, [renderedState, dir]);

			const editor = useEditMode({
				path,
				currentText: text ?? '',
				onSaved: (next) => setState({ status: 'ready', text: next }),
				t, onStatus,
			});
			// lift the editing flag to the panel: an external-change event must not
			// clobber an active editor, it shows a conflict bar instead
			useEffect(() => {
				onEditingChange?.(editor.editing);
				return () => onEditingChange?.(false);
			}, [editor.editing, onEditingChange]);
			const [editorQuery, setEditorQuery] = useState('');
			const editorSearch = useEditorSearch(editor.editing ? editor.draft : '');
			// edit mode: live outline from the debounced draft, same sidebar as preview
			const [outlineDraft, setOutlineDraft] = useState(null);
			useEffect(() => {
				if (!editor.editing) { setOutlineDraft(null); return undefined; }
				const timer = setTimeout(() => setOutlineDraft(editor.draft), 300);
				return () => clearTimeout(timer);
			}, [editor.editing, editor.draft]);
			const draftOutline = useMemo(() => (editor.editing && outlineDraft !== null ? extractDraftOutline(outlineDraft) : null), [editor.editing, outlineDraft]);
			const gotoDraftHeading = (item) => {
				const el = editorSearch.areaRef.current;
				if (!el || typeof item.lineOffset !== 'number') return;
				el.focus();
				el.setSelectionRange(item.lineOffset, item.lineOffset);
				const top = measureTextareaTop(el, editor.draft, item.lineOffset);
				if (top !== null) el.scrollTop = Math.max(0, Math.round(top - el.clientHeight / 2));
				else {
					const line = (editor.draft.slice(0, item.lineOffset).match(/\n/g) ?? []).length;
					const lineH = parseFloat(getComputedStyle(el).lineHeight) || 22;
					el.scrollTop = Math.max(0, Math.round(line * lineH - el.clientHeight / 2));
				}
			};
			useEffect(() => {
				if (editor.editing) {
					// during the debounce window the draft outline is not ready yet —
					// keep the preview outline mounted instead of flashing empty
					if (draftOutline === null) return;
					onSidebar(draftOutline.length > 0
						? { kind: 'outline', items: draftOutline, go: (id) => gotoDraftHeading(draftOutline.find((x) => x.id === id)) }
						: null);
				} else if (renderedState) onSidebar(renderedState.outline.length > 0 ? outlineModel(renderedState.outline) : null);
			}, [editor.editing, draftOutline, renderedState]);

			// bind scroll persistence only once the scroll container actually
			// exists (it mounts with the rendered content, after async fetch)
			const mdChunks = useMemo(() => (renderedState?.plain ? splitTextChunks(text ?? '') : null), [renderedState, text]);
			const mdReady = state.status === 'ready' && !!renderedState && !editor.editing;
			useScrollRestore(path, scrollRef, () => ({ kind: 'markdown', fontSize }), mdReady);

			if (state.status === 'error') return h('div', { className: 'dr-error' }, `${t('panel.error')}: ${state.message}`);
			if (renderError) return h('div', { className: 'dr-error' }, `${t('panel.error')}: ${renderError} — ${t('panel.retryHint')}`);
			if (state.status !== 'ready' || !renderedState) return h('div', { className: 'dr-load' }, t('panel.loading'));
			return h(React.Fragment, null,
				h(ViewBar, null,
					editor.editing
						? h(React.Fragment, null,
							h(SearchControls, { t, query: editorQuery, setQuery: setEditorQuery, count: editorSearch.count, index: editorSearch.index,
								onEnter: (dirn) => (editorQuery.trim() ? editorSearch.run(editorQuery, dirn) : undefined),
								onPrev: () => editorSearch.navigate(-1), onNext: () => editorSearch.navigate(1) }),
								h('span', { style: { flex: 1 } }),
								h(EditControls, { t, editing: true, dirty: editor.dirty, busy: editor.busy, onEnter: editor.enter, onExit: editor.exit, onSave: editor.save }))
						: h(React.Fragment, null,
							h(SearchControls, { t, query, setQuery, count, index,
								onEnter: (dirn) => (query.trim() ? search.run(query, dirn) : search.clear()),
								onPrev: () => search.navigate(-1), onNext: () => search.navigate(1) }),
							h('span', { style: { flex: 1 } }),
							h(Btn, { title: t('panel.fontSmaller'), onClick: () => setFontSize((s) => Math.max(10, s - 1)) }, 'A−'),
							h('span', { className: 'dr-badge' }, `${fontSize}px`),
							h(Btn, { title: t('panel.fontBigger'), onClick: () => setFontSize((s) => Math.min(40, s + 1)) }, 'A+'),
							h(Btn, { title: t('panel.fontReset'), onClick: () => setFontSize(settings.fontSize) }, 'A'),
							renderedState.plain && h('span', { className: 'dr-badge', title: t('panel.mdPlainMode') }, t('panel.mdPlainMode')),
					h(EditControls, { t, editing: false, dirty: false, busy: false, onEnter: editor.enter, onExit: editor.exit, onSave: editor.save }))),
				h('div', { className: 'dr-stage', style: { '--dr-line-height': settings.lineHeight } },
					sidebar,
					editor.editing
						? h('div', { className: 'dr-scroll' },
							h(EditorPane, { value: editor.draft, onChange: editor.setDraft, onSave: editor.save, busy: editor.busy, label: path, areaRef: editorSearch.areaRef }))
						: h('div', { className: 'dr-scroll', ref: scrollRef },
							renderedState.plain
								? h('pre', { className: 'dr-text', ref: bodyRef, style: { fontSize: `${fontSize}px` } },
									(mdChunks
										? mdChunks.map((chunk, i) => h('div', { key: i, style: { contentVisibility: 'auto', containIntrinsicSize: 'auto 1200px' } }, chunk))
										: text))
								: h('article', {
									className: 'dr-md', ref: bodyRef, style: { fontSize: `${fontSize}px` },
									dangerouslySetInnerHTML: { __html: renderedState.html },
								}))),
				h(SaveFontSize, { path, kind: 'markdown', fontSize }));
		}
		// persist font size with the scroll position
		function SaveFontSize({ path, kind, fontSize }) {
			useEffect(() => {
				const saved = getPos(path);
				if (saved && saved.kind === kind && saved.fontSize !== fontSize) savePos(path, { ...saved, fontSize });
			}, [fontSize]);
			return null;
		}

		// ---------- Text ----------
		// Large plain-text files render in line-aligned chunks with
		// content-visibility:auto — the DOM stays complete (search/highlight
		// unaffected) but layout work happens only near the viewport.
		const TEXT_CHUNK_THRESHOLD = 512 * 1024;
		const TEXT_CHUNK_SIZE = 96 * 1024;
		function splitTextChunks(text) {
			if (text.length <= TEXT_CHUNK_THRESHOLD) return null;
			const chunks = [];
			let start = 0;
			while (start < text.length) {
				let end = Math.min(text.length, start + TEXT_CHUNK_SIZE);
				if (end < text.length) {
					const nl = text.lastIndexOf('\n', end);
					if (nl > start + TEXT_CHUNK_SIZE / 2) end = nl + 1;
				}
				chunks.push(text.slice(start, end));
				start = end;
			}
			return chunks;
		}

		function TextView({ path, settings, t, onStatus, onSidebar, sidebar, onEditingChange }) {
			const [state, setState] = useState({ status: 'loading' });
			const [fontSize, setFontSize] = useState(() => {
				const pos = getPos(path);
				return (pos && pos.kind === 'text' && typeof pos.fontSize === 'number') ? pos.fontSize : settings.fontSize;
			});
			const [query, setQuery] = useState('');
			const [count, setCount] = useState(0);
			const [index, setIndex] = useState(-1);
			const bodyRef = useRef(null);
			const scrollRef = useRef(null);
			const search = useDomSearch(bodyRef, (total, idx) => { setCount(total); setIndex(idx); }, onStatus, t);
			useEffect(() => { let alive = true; setState({ status: 'loading' }); onSidebar(null);
				const controller = new AbortController();
				fetchFile(path, 'text', controller.signal).then((text) => alive && setState({ status: 'ready', text }))
					.catch((e) => { if (alive && e?.name !== 'AbortError') setState({ status: 'error', message: e.message }); });
				return () => { alive = false; controller.abort(); };
			}, [path]);
			const textChunks = useMemo(() => (state.status === 'ready' ? splitTextChunks(state.text) : null), [state]);
			const editor = useEditMode({
				path,
				currentText: state.status === 'ready' ? state.text : '',
				onSaved: (text) => setState({ status: 'ready', text }),
				t, onStatus,
			});
			useEffect(() => {
				onEditingChange?.(editor.editing);
				return () => onEditingChange?.(false);
			}, [editor.editing, onEditingChange]);
			const [editorQuery, setEditorQuery] = useState('');
			const editorSearch = useEditorSearch(editor.editing ? editor.draft : '');
			useScrollRestore(path, scrollRef, () => ({ kind: 'text', fontSize }), state.status === 'ready' && !editor.editing);
			if (state.status === 'error') return h('div', { className: 'dr-error' }, `${t('panel.error')}: ${state.message}`);
			if (state.status !== 'ready') return h('div', { className: 'dr-load' }, t('panel.loading'));
			return h(React.Fragment, null,
				h(ViewBar, null,
					editor.editing
						? h(React.Fragment, null,
							h(SearchControls, { t, query: editorQuery, setQuery: setEditorQuery, count: editorSearch.count, index: editorSearch.index,
								onEnter: (dirn) => (editorQuery.trim() ? editorSearch.run(editorQuery, dirn) : undefined),
								onPrev: () => editorSearch.navigate(-1), onNext: () => editorSearch.navigate(1) }),
								h('span', { style: { flex: 1 } }),
								h(EditControls, { t, editing: true, dirty: editor.dirty, busy: editor.busy, onEnter: editor.enter, onExit: editor.exit, onSave: editor.save }))
						: h(React.Fragment, null,
							h(SearchControls, { t, query, setQuery, count, index,
								onEnter: () => (query.trim() ? search.run(query, 1) : search.clear()),
								onPrev: () => search.navigate(-1), onNext: () => search.navigate(1) }),
							h('span', { style: { flex: 1 } }),
							h(Btn, { title: t('panel.fontSmaller'), onClick: () => setFontSize((s) => Math.max(10, s - 1)) }, 'A−'),
							h('span', { className: 'dr-badge' }, `${fontSize}px`),
							h(Btn, { title: t('panel.fontBigger'), onClick: () => setFontSize((s) => Math.min(40, s + 1)) }, 'A+'),
							h(Btn, { title: t('panel.fontReset'), onClick: () => setFontSize(settings.fontSize) }, 'A'),
							h(EditControls, { t, editing: false, dirty: false, busy: false, onEnter: editor.enter, onExit: editor.exit, onSave: editor.save }))),
				h('div', { className: 'dr-stage', style: { '--dr-line-height': settings.lineHeight } },
					sidebar,
					editor.editing
						? h('div', { className: 'dr-scroll' },
							h(EditorPane, { value: editor.draft, onChange: editor.setDraft, onSave: editor.save, busy: editor.busy, label: path, areaRef: editorSearch.areaRef }))
						: h('div', { className: 'dr-scroll', ref: scrollRef },
							h('pre', { className: 'dr-text', ref: bodyRef, style: { fontSize: `${fontSize}px` } },
								textChunks
									? textChunks.map((chunk, i) => h('div', { key: i, style: { contentVisibility: 'auto', containIntrinsicSize: 'auto 1200px' } }, chunk))
									: state.text))),
				h(SaveFontSize, { path, kind: 'text', fontSize }));
		}

		// ---------- PDF (continuous scroll) ----------
		function PdfView({ path, settings, t, onStatus, onSidebar, sidebar }) {
			const [docState, setDocState] = useState(null); // { doc, numPages }
			const [error, setError] = useState(null);
			const [scale, setScale] = useState(null);
			const [page, setPage] = useState(1);
			const [query, setQuery] = useState('');
			const [matches, setMatches] = useState(null); // null=idle []=none [{page,index}]
			const [matchIndex, setMatchIndex] = useState(-1);
			const scrollRef = useRef(null);
			const docRef = useRef(null);
			const shellsRef = useRef(new Map());
			const renderRef = useRef(new Map());
			const observerRef = useRef(null);
			const textCacheRef = useRef(new Map());
			const searchTokenRef = useRef(0);
			const scaleRef = useRef(null);
			scaleRef.current = scale;
			const pageRef = useRef(1);
			pageRef.current = page;
			const basePageHRef = useRef(0);

			// load document
			useEffect(() => {
				let alive = true; setDocState(null); setError(null); setScale(null); setPage(1); setMatches(null); setMatchIndex(-1);
				onSidebar(null);
				docRef.current?.destroy(); docRef.current = null;
				shellsRef.current.clear(); renderRef.current.clear(); textCacheRef.current.clear(); observerRef.current?.disconnect(); observerRef.current = null;
				searchTokenRef.current += 1; // kill any in-flight full-text search of the old document
				const controller = new AbortController();
				(async () => {
					try {
						const [lib, buf] = await Promise.all([loadPdfjs(), fetchFile(path, undefined, controller.signal)]);
						if (!alive) return;
						const doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise;
						if (!alive) { doc.destroy(); return; }
						docRef.current = doc;
						setDocState({ doc, numPages: doc.numPages });
						onSidebar({ kind: 'pages', docKind: 'pdf', numPages: doc.numPages });
					} catch (e) { if (alive && e?.name !== 'AbortError') setError(e.message); }
				})();
				return () => { alive = false; controller.abort(); docRef.current?.destroy(); docRef.current = null; observerRef.current?.disconnect(); onSidebar(null); };
			}, [path]);

			// fit-width default scale + position restore, once doc ready
			useEffect(() => {
				if (!docState || scale !== null) return undefined;
				let alive = true;
				(async () => {
					try {
						const first = await docState.doc.getPage(1);
						if (!alive) return;
						const viewport = first.getViewport({ scale: 1 });
						basePageHRef.current = viewport.height;
						const width = viewport.width;
						const el = scrollRef.current;
						const available = el ? el.clientWidth - 36 : 800;
						const saved = getPos(path);
						const fit = clamp(Number((Math.min(1, available / Math.max(width, 1)).toFixed(3))), 0.5, 4);
						setScale(saved?.kind === 'pdf' && Number.isFinite(saved.scale) ? clamp(saved.scale, 0.5, 4) : fit);
						if (saved?.kind === 'pdf' && Number.isFinite(saved.page)) setPage(clamp(Math.round(saved.page), 1, docState.numPages));
					} catch { /* doc destroyed mid-load */ }
				})();
				return () => { alive = false; };
			}, [docState]);

			// command a page render into its shell
			const renderPage = useCallback(async (pageNumber) => {
				const doc = docRef.current;
				const shell = shellsRef.current.get(pageNumber);
				const target = scaleRef.current; // capture: scale may change mid-render
				if (!doc || !shell || target === null) return;
				const rs = renderRef.current.get(pageNumber) ?? { rendering: false, renderedScale: 0 };
				if (rs.rendering || rs.renderedScale === target) return;
				rs.rendering = true;
				renderRef.current.set(pageNumber, rs);
				let ok = false;
				try {
					const pg = await doc.getPage(pageNumber);
					if (!docRef.current || !shellsRef.current.get(pageNumber)) return;
					const viewport = pg.getViewport({ scale: target });
					let canvas = shell.querySelector('canvas');
					if (!canvas) { canvas = document.createElement('canvas'); shell.appendChild(canvas); }
					const dpr = window.devicePixelRatio || 1;
					canvas.width = Math.floor(viewport.width * dpr);
					canvas.height = Math.floor(viewport.height * dpr);
					canvas.style.width = `${Math.floor(viewport.width)}px`;
					canvas.style.height = `${Math.floor(viewport.height)}px`;
					// pin the shell height so recycling the canvas cannot shift layout
					shell.style.height = `${Math.floor(viewport.height)}px`;
					shell.dataset.h = '1';
					const context = canvas.getContext('2d', { alpha: false });
					context.setTransform(dpr, 0, 0, dpr, 0, 0);
					await pg.render({ canvasContext: context, viewport }).promise;
					if (!docRef.current) return;
					ok = true;
				} catch (e) {
					shell.setAttribute('data-error', t('panel.pdfRenderFailed'));
					const bad = shell.querySelector('canvas');
					if (bad) { bad.width = 1; bad.height = 1; bad.remove(); } // failed renders must not hold bitmaps
				} finally {
					const rs3 = renderRef.current.get(pageNumber);
					if (rs3) { rs3.rendering = false; rs3.renderedScale = ok ? target : 0; }
					if (ok && scaleRef.current !== target) void renderPage(pageNumber); // zoom moved on: re-render at the new scale
				}
			}, []);

			// release the bitmap of pages far outside the viewport (canvas LRU)
			const prunePage = useCallback((pageNumber) => {
				const rs = renderRef.current.get(pageNumber);
				if (!rs || rs.rendering || rs.renderedScale === 0) return;
				const shell = shellsRef.current.get(pageNumber);
				const canvas = shell?.querySelector('canvas');
				if (canvas) { canvas.width = 1; canvas.height = 1; canvas.remove(); }
				rs.renderedScale = 0;
				// unpin the height and re-estimate at the CURRENT scale so the scrollbar
				// does not jump when the page re-renders after a zoom change
				if (shell && scaleRef.current !== null && basePageHRef.current > 0) {
					delete shell.dataset.h;
					shell.style.height = `${Math.round(basePageHRef.current * scaleRef.current)}px`;
				}
			}, []);

			const renderVisible = useCallback(() => {
				const el = scrollRef.current;
				if (!el) return;
				const top = el.scrollTop - 900;
				const bottom = el.scrollTop + el.clientHeight + 900;
				const current = pageRef.current;
				const keep = Math.max(4, Math.round(12 / Math.max(0.75, scaleRef.current ?? 1))); // high zoom = heavy bitmaps: keep fewer
				for (const [num, shell] of shellsRef.current.entries()) {
					const shellTop = shell.offsetTop;
					const near = shellTop + shell.offsetHeight >= top && shellTop <= bottom;
					if (near) void renderPage(num);
					else if (Math.abs(num - current) > keep) prunePage(num);
				}
			}, [renderPage, prunePage]);

			// observer + shells after doc ready
			useEffect(() => {
				if (!docState || !scrollRef.current) return;
				const observer = new IntersectionObserver((entries) => {
					for (const entry of entries) {
						if (!entry.isIntersecting) continue;
						const num = Number(entry.target.dataset.page || '0');
						if (num > 0) void renderPage(num);
					}
				}, { root: scrollRef.current, rootMargin: '900px 0px', threshold: 0.01 });
				observerRef.current = observer;
				for (const shell of shellsRef.current.values()) observer.observe(shell);
				// after shells mount: jump to restored page
				const target = page;
				requestAnimationFrame(() => {
					scrollToPage(target, 'auto');
					renderVisible();
				});
				return () => { observer.disconnect(); observerRef.current = null; };
			}, [docState]);

			// scale change: invalidate rendered pages, keep page anchored
			useEffect(() => {
				if (scale === null || !docState) return;
				for (const rs of renderRef.current.values()) rs.renderedScale = 0;
				// pre-size not-yet-rendered shells with the page-1 estimate so the
				// scrollbar does not jump as pages render in
				if (basePageHRef.current > 0) {
					for (const shell of shellsRef.current.values()) {
						if (!shell.dataset.h) shell.style.height = `${Math.round(basePageHRef.current * scale)}px`;
					}
				}
				requestAnimationFrame(() => { scrollToPage(pageRef.current, 'auto'); renderVisible(); });
			}, [scale]);

			const scrollToPage = useCallback((pageNumber, behavior = 'smooth') => {
				const shell = shellsRef.current.get(clamp(pageNumber, 1, docRef.current?.numPages ?? 1));
				if (!shell) return;
				setPage(clamp(pageNumber, 1, docRef.current.numPages));
				shell.scrollIntoView({ behavior, block: 'start' });
				void renderPage(clamp(pageNumber, 1, docRef.current.numPages));
			}, [renderPage]);

			// viewport page tracking + position save + status
			useEffect(() => {
				const el = scrollRef.current;
				if (!el || !docState) return;
				let raf = 0;
				let timer;
				let closest = 1; // declared here: the debounce timer below must see it
				const onScroll = () => {
					if (raf) return;
					raf = requestAnimationFrame(() => {
						raf = 0;
						const mid = el.scrollTop + el.clientHeight / 2;
						closest = 1;
						let best = Infinity;
						for (const [num, shell] of shellsRef.current.entries()) {
							const center = shell.offsetTop + shell.offsetHeight / 2;
							const distance = Math.abs(center - mid);
							if (distance < best) { best = distance; closest = num; }
						}
						setPage((prev) => (closest !== prev ? closest : prev));
						renderVisible();
					});
					clearTimeout(timer);
					timer = setTimeout(() => {
						if (docRef.current && scaleRef.current !== null) {
							savePos(path, { kind: 'pdf', page: closest, scale: scaleRef.current });
						}
						onStatus(`${t('panel.page')} ${closest}/${docRef.current?.numPages} • ${Math.round(scaleRef.current * 100)}%`);
					}, 300);
				};
				el.addEventListener('scroll', onScroll, { passive: true });
				return () => {
					el.removeEventListener('scroll', onScroll);
					clearTimeout(timer);
					if (raf) cancelAnimationFrame(raf);
					if (scaleRef.current !== null && shellsRef.current.size > 0) {
						// docRef is already null after the load effect's cleanup — but the
						// document was real when this listener was bound, so flush anyway
						savePos(path, { kind: 'pdf', page: closest, scale: scaleRef.current });
					}
				};
			}, [docState]);

			// ctrl/cmd wheel zoom (throttled)
			useEffect(() => {
				const el = scrollRef.current;
				if (!el || !docState) return;
				let last = 0;
				const onWheel = (event) => {
					if (!(event.ctrlKey || event.metaKey)) return;
					event.preventDefault();
					const now = Date.now();
					if (now - last < 60) return;
					last = now;
					setScale((s) => (s === null ? s : clamp(Number((s + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(2)), 0.5, 4)));
				};
				el.addEventListener('wheel', onWheel, { passive: false });
				return () => el.removeEventListener('wheel', onWheel);
			}, [docState]);

			// sidebar thumbnails navigate
			useEffect(() => {
				if (!docState) return;
				onSidebar({ kind: 'pages', docKind: 'pdf', numPages: docState.numPages, currentPage: page, go: (n) => scrollToPage(n, 'smooth') });
			}, [page, scrollToPage]);

			// PDF text search
			const runSearch = useCallback(async (direction) => {
				const doc = docRef.current;
				const needle = query.trim().toLowerCase();
				const scan = async () => {
				if (!doc) return;
				if (!needle) { setMatches(null); setMatchIndex(-1); return; }
				if (!settings.pdfTextLayer) { onStatus(t('panel.pdfSearchDisabled')); return; }
				let current = matches;
				if (searchDirtyRef.current || !Array.isArray(current)) {
					const token = ++searchTokenRef.current;
					onStatus(t('panel.searching'));
					const found = [];
					for (let p = 1; p <= doc.numPages; p += 1) {
						if (searchTokenRef.current !== token) return;
						let text = textCacheRef.current.get(p);
						if (text === undefined) {
							const pg = await doc.getPage(p);
							const content = await pg.getTextContent();
							text = content.items.map((item) => (typeof item.str === 'string' ? item.str : '')).join(' ');
							if (searchTokenRef.current !== token) return; // check BEFORE caching: never pollute a new document
							textCacheRef.current.set(p, text);
						if (textCacheRef.current.size > 500) { // bound the cache: big books would otherwise hold tens of MB
							const keys = [...textCacheRef.current.keys()].slice(0, 250);
							for (const k of keys) textCacheRef.current.delete(k);
						}
						}
						if (searchTokenRef.current !== token) return;
						let from = 0;
						const lowered = text.toLowerCase();
						while (from < lowered.length) {
							const at = lowered.indexOf(needle, from);
							if (at < 0) break;
							found.push({ page: p, index: at });
							from = at + needle.length;
						}
					}
					if (searchTokenRef.current !== token) return;
					current = found;
					setMatches(found);
					setMatchIndex(-1);
					searchDirtyRef.current = false;
					if (found.length === 0) { onStatus(t('panel.noMatches')); return; }
				}
				if (!current || current.length === 0) { onStatus(t('panel.noMatches')); return; }
				const next = matchIndex < 0 ? 0 : matchIndex + direction;
				const normalized = ((next % current.length) + current.length) % current.length;
				setMatchIndex(normalized);
				scrollToPage(current[normalized].page, 'smooth');
				onStatus(`${normalized + 1}/${current.length} • ${t('panel.page')} ${current[normalized].page}`);
				};
				try { await scan(); } catch { /* doc destroyed mid-scan */ }
			}, [query, matches, matchIndex, scrollToPage, settings.pdfTextLayer]);
			const searchDirtyRef = useRef(true);
			useEffect(() => {
				searchTokenRef.current += 1; // new query or new document cancels the in-flight scan
				searchDirtyRef.current = true;
				setMatches(null);
				setMatchIndex(-1);
			}, [query, path]);

			if (error) return h('div', { className: 'dr-error' }, `${t('panel.error')}: ${error}`);
			if (!docState) return h('div', { className: 'dr-load' }, t('panel.loadingPdf'));
			return h(React.Fragment, null,
				h(ViewBar, null,
					h(SearchControls, { t, query, setQuery, count: matches?.length ?? 0, index: matchIndex, disabled: !settings.pdfTextLayer,
						onEnter: (dirn) => void runSearch(dirn), onPrev: () => void runSearch(-1), onNext: () => void runSearch(1) }),
					h('span', { style: { flex: 1 } }),
					h('span', { className: 'dr-badge' }, `${page}/${docState.numPages}`),
					h(Btn, { title: t('panel.prevPage'), onClick: () => scrollToPage(page - 1), disabled: page <= 1 }, '‹'),
					h(Btn, { title: t('panel.nextPage'), onClick: () => scrollToPage(page + 1), disabled: page >= docState.numPages }, '›'),
					h(Btn, { title: t('panel.zoomOut'), onClick: () => setScale((s) => clamp(Number(((s ?? 1) - 0.1).toFixed(2)), 0.5, 4)) }, '−'),
					h('span', { className: 'dr-badge' }, scale === null ? '' : `${Math.round(scale * 100)}%`),
					h(Btn, { title: t('panel.zoomIn'), onClick: () => setScale((s) => clamp(Number(((s ?? 1) + 0.1).toFixed(2)), 0.5, 4)) }, '+'),
					h(Btn, { title: t('panel.zoomReset'), onClick: () => setScale(1) }, '100%')),
				h('div', { className: 'dr-stage' },
					sidebar,
					h('div', { className: 'dr-scroll', ref: scrollRef },
						h('div', { className: 'dr-pdf-doc' },
							Array.from({ length: docState.numPages }, (_, i) => h('div', {
								key: i + 1, className: 'dr-pdf-shell', 'data-page': `${i + 1}`,
								ref: (el) => { if (el) shellsRef.current.set(i + 1, el); else shellsRef.current.delete(i + 1); },
							}))))));
		}

		// ---------- DOCX ----------
		function DocxView({ path, settings, t, onStatus, onSidebar, sidebar }) {
			const [error, setError] = useState(null);
			const [ready, setReady] = useState(false);
			const [zoom, setZoom] = useState(null);
			const [page, setPage] = useState(1);
			const [pageCount, setPageCount] = useState(1);
			const scrollRef = useRef(null);
			const rootRef = useRef(null); // .dr-docx-inner
			const pagesRef = useRef([]); // page elements / anchors
			const metaPagesRef = useRef(null);
			const zoomRef = useRef(null);
			zoomRef.current = zoom;
			const pageRef = useRef(1);
			pageRef.current = page;

			const scrollToPage = useCallback((pageNumber, behavior = 'smooth') => {
				const pages = pagesRef.current;
				if (pages.length === 0) return;
				const normalized = clamp(pageNumber, 1, pages.length);
				setPage(normalized);
				pagesRef.current[normalized - 1]?.scrollIntoView({ behavior, block: 'start' });
			}, []);

			// render + page synthesis
			useEffect(() => {
				let alive = true; setError(null); setReady(false); setZoom(null); setPage(1); setPageCount(1); onSidebar(null);
				restoredRef.current = false;
				pagesRef.current = []; metaPagesRef.current = null;
				const controller = new AbortController();
				(async () => {
					try {
						const [vendor, buf] = await Promise.all([loadVendor(), fetchFile(path, undefined, controller.signal)]);
						if (!alive || !rootRef.current) return;
						if (buf.byteLength > 100 * 1024 * 1024) throw new Error(t('panel.docxTooLarge'));
						rootRef.current.innerHTML = '';
						// metadata page count from docProps/app.xml (VSCode-extension behaviour)
						try {
							const zip = await vendor.JSZip.loadAsync(buf);
							const appXml = zip.file('docProps/app.xml');
							if (appXml) {
								const xml = await appXml.async('string');
								const parsed = new DOMParser().parseFromString(xml, 'application/xml');
								const pagesNode = Array.from(parsed.getElementsByTagName('*')).find((n) => n.localName === 'Pages');
								const value = Number.parseInt(pagesNode?.textContent?.trim() ?? '', 10);
								if (Number.isFinite(value) && value > 0 && value <= 5000) metaPagesRef.current = value;
							}
						} catch { /* metadata optional */ }
						if (!alive) return;
						await vendor.loadDocx().renderAsync(buf, rootRef.current, null, {
							inWrapper: true, ignoreWidth: false, ignoreHeight: false,
							breakPages: settings.docxBreakPages,
							renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
							ignoreLastRenderedPageBreak: false, useBase64URL: true,
							experimental: true, renderChanges: true, renderComments: true, renderAltChunks: true,
						});
						if (!alive) return;
						// page synthesis: sections when paginated, else virtual anchors by height
						const wrapper = rootRef.current.querySelector('.docx-wrapper');
						const sections = wrapper ? Array.from(wrapper.querySelectorAll(':scope > section.docx')) : [];
						const buildPages = () => {
							if (sections.length > 1) {
								sections.forEach((s, i) => s.setAttribute('data-page', `${i + 1}`));
								return sections;
							}
							const single = sections[0] ?? wrapper;
							if (!single) return [rootRef.current];
							const styles = getComputedStyle(single);
							const width = Number.parseFloat(styles.width) || single.clientWidth || 794;
							const minHeight = Number.parseFloat(styles.minHeight);
							const declared = Number.parseFloat(styles.height);
							const pageHeight = (Number.isFinite(minHeight) && minHeight > 0 ? minHeight
								: Number.isFinite(declared) && declared > 0 ? declared : width * 1.414) || width * 1.414;
							const childMax = Array.from(single.children).reduce((max, child) => Math.max(max, child.offsetTop + child.offsetHeight), 0);
							const totalHeight = Math.max(single.scrollHeight, single.offsetHeight, childMax, pageHeight);
							const estimated = pageHeight > 0 ? Math.max(1, Math.ceil(totalHeight / pageHeight)) : 1;
							const meta = metaPagesRef.current && metaPagesRef.current > 1 ? Math.round(metaPagesRef.current) : 1;
							const target = Math.max(estimated, meta);
							single.style.position = 'relative';
							single.querySelectorAll(':scope > .dr-docx-anchor').forEach((a) => a.remove());
							if (target <= 1) { single.setAttribute('data-page', '1'); return [single]; }
							const anchors = [];
							const maxTop = Math.max(0, totalHeight - 1);
							for (let i = 0; i < target; i += 1) {
								const anchor = document.createElement('div');
								anchor.className = 'dr-docx-anchor';
								anchor.setAttribute('data-page', `${i + 1}`);
								anchor.style.top = `${Math.round(maxTop * (target <= 1 ? 0 : i / (target - 1)))}px`;
								single.appendChild(anchor);
								anchors.push(anchor);
							}
							return anchors;
						};
						pagesRef.current = buildPages();
						setPageCount(Math.max(pagesRef.current.length, 1));
						// default fit-width zoom
						const firstPage = wrapper?.querySelector(':scope > section.docx');
						const pageWidth = firstPage?.offsetWidth ?? 794;
						const available = scrollRef.current ? scrollRef.current.clientWidth - 36 : 800;
						const fit = clamp(Number((Math.min(1, available / Math.max(pageWidth, 1)).toFixed(3))), 0.5, 3);
						const saved = getPos(path);
						setZoom(saved?.kind === 'docx' && Number.isFinite(saved.scale) ? clamp(saved.scale, 0.5, 3) : fit);
						setReady(true);
						onStatus(t('panel.docxRendered'));
						// second layout pass
						requestAnimationFrame(() => requestAnimationFrame(() => {
							if (!alive) return;
							pagesRef.current = buildPages();
							setPageCount(Math.max(pagesRef.current.length, 1));
						}));
					} catch (e) { if (alive && e?.name !== 'AbortError') setError(e.message); }
				})();
				return () => { alive = false; controller.abort(); if (rootRef.current) rootRef.current.innerHTML = ''; onSidebar(null); };
			}, [path, settings.docxBreakPages]);

			// apply zoom via CSS zoom; restore the saved scroll position only once after first render
			const restoredRef = useRef(false);
			useEffect(() => {
				const inner = rootRef.current;
				if (!inner || zoom === null) return;
				inner.style.zoom = `${zoom}`;
				if (restoredRef.current) return;
				restoredRef.current = true;
				const saved = getPos(path);
				if (saved?.kind === 'docx' && typeof saved.scrollTop === 'number') {
					requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = saved.scrollTop; });
				}
			}, [zoom, ready]);

			// viewport page tracking + save
			useEffect(() => {
				const el = scrollRef.current;
				if (!el || !ready) return;
				let raf = 0; let timer;
				const onScroll = () => {
					if (raf) return;
					raf = requestAnimationFrame(() => {
						raf = 0;
						const top = el.getBoundingClientRect().top + 12;
						let active = 1; let nearest = 1; let nearestDistance = Infinity;
						pagesRef.current.forEach((pel, i) => {
							const num = Number.parseInt(pel.getAttribute('data-page') || `${i + 1}`, 10) || i + 1;
							const distance = pel.getBoundingClientRect().top - top;
							if (distance <= 0) active = num;
							if (Math.abs(distance) < nearestDistance) { nearestDistance = Math.abs(distance); nearest = num; }
						});
						const next = active || nearest;
						setPage((prev) => (next !== prev ? next : prev));
					});
					clearTimeout(timer);
					timer = setTimeout(() => {
						savePos(path, { kind: 'docx', scrollTop: Math.round(el.scrollTop), scale: zoomRef.current ?? 1 });
						onStatus(`${t('panel.page')} ${pageRef.current}/${pagesRef.current.length} • ${Math.round((zoomRef.current ?? 1) * 100)}%`);
					}, 300);
				};
				el.addEventListener('scroll', onScroll, { passive: true });
				return () => { el.removeEventListener('scroll', onScroll); clearTimeout(timer); if (raf) cancelAnimationFrame(raf); };
			}, [ready]);

			// ctrl/cmd wheel zoom
			useEffect(() => {
				const el = scrollRef.current;
				if (!el || !ready) return;
				let last = 0;
				const onWheel = (event) => {
					if (!(event.ctrlKey || event.metaKey)) return;
					event.preventDefault();
					const now = Date.now();
					if (now - last < 60) return;
					last = now;
					setZoom((z) => (z === null ? z : clamp(Number((z + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(2)), 0.5, 3)));
				};
				el.addEventListener('wheel', onWheel, { passive: false });
				return () => el.removeEventListener('wheel', onWheel);
			}, [ready]);

			// sidebar pages
			useEffect(() => {
				if (!ready) return;
				onSidebar({ kind: 'pages', docKind: 'docx', numPages: pageCount, currentPage: page, go: (n) => scrollToPage(n, 'smooth') });
			}, [ready, page, pageCount, scrollToPage]);

			if (error) return h('div', { className: 'dr-error' }, `${t('panel.error')}: ${error}`);
			return h(React.Fragment, null,
				h(ViewBar, null,
					h('span', { className: 'dr-badge' }, `${page}/${pageCount}`),
					h(Btn, { title: t('panel.prevPage'), onClick: () => scrollToPage(page - 1), disabled: page <= 1 }, '‹'),
					h(Btn, { title: t('panel.nextPage'), onClick: () => scrollToPage(page + 1), disabled: page >= pageCount }, '›'),
					h('span', { style: { flex: 1 } }),
					h(Btn, { title: t('panel.zoomOut'), onClick: () => setZoom((z) => clamp(Number(((z ?? 1) - 0.1).toFixed(2)), 0.5, 3)) }, '−'),
					h('span', { className: 'dr-badge' }, zoom === null ? '' : `${Math.round(zoom * 100)}%`),
					h(Btn, { title: t('panel.zoomIn'), onClick: () => setZoom((z) => clamp(Number(((z ?? 1) + 0.1).toFixed(2)), 0.5, 3)) }, '+'),
					h(Btn, { title: t('panel.zoomReset'), onClick: () => setZoom(1) }, '100%')),
				h('div', { className: 'dr-stage' },
					sidebar,
					h('div', { className: 'dr-scroll dr-docx-scroll', ref: scrollRef },
						h('div', { className: 'dr-docx-inner', ref: rootRef }),
						!ready && !error && h('div', { className: 'dr-load' }, t('panel.loading')))));
		}

		// ---------- Image ----------
		function ImageView({ path, t, onStatus, onSidebar }) {
			const [error, setError] = useState(null);
			const [natural, setNatural] = useState(null); // {width,height}
			const [scale, setScale] = useState(1);
			const [rotation, setRotation] = useState(0);
			const [fitMode, setFitMode] = useState('window'); // null | 'window' | 'width'
			const stageRef = useRef(null);
			const scrollRef = useRef(null);
			const [viewportTick, setViewportTick] = useState(0);
			const pendingScrollRef = useRef(null);
			const [downsampled, setDownsampled] = useState(null); // blob URL for huge images
			const downsampledRef = useRef(null);
			const dsTokenRef = useRef(0); // invalidates in-flight downsampling on file switch
			useEffect(() => () => { if (downsampledRef.current) URL.revokeObjectURL(downsampledRef.current); }, []);
			useEffect(() => {
				let raf = 0;
				const onResize = () => {
					if (raf) return;
					raf = requestAnimationFrame(() => { raf = 0; setViewportTick((v) => v + 1); });
				};
				window.addEventListener('resize', onResize);
				return () => { window.removeEventListener('resize', onResize); if (raf) cancelAnimationFrame(raf); };
			}, []);

			// restore (also resets stale state when switching image -> image)
			useEffect(() => {
				setError(null);
				setNatural(null);
				pendingScrollRef.current = null;
				dsTokenRef.current += 1;
				if (downsampledRef.current) { URL.revokeObjectURL(downsampledRef.current); downsampledRef.current = null; }
				setDownsampled(null);
				const saved = getPos(path);
				if (saved?.kind === 'image') {
					setScale(Number.isFinite(saved.scale) ? clamp(saved.scale, 0.1, 8) : 1);
					setRotation(Number.isFinite(saved.rotation) ? ((Math.round(saved.rotation) % 360) + 360) % 360 : 0);
					setFitMode(saved.fitMode === 'width' || saved.fitMode === 'window' ? saved.fitMode : 'window');
					if (typeof saved.scrollTop === 'number') pendingScrollRef.current = saved.scrollTop;
				} else {
					setScale(1); setRotation(0); setFitMode('window');
				}
				onSidebar(null);
			}, [path]);

			// save (debounced on any transform change OR plain scrolling)
			useEffect(() => {
				if (!natural) return undefined;
				let timer;
				const save = () => {
					timer = setTimeout(() => {
						savePos(path, { kind: 'image', scale, rotation, fitMode, scrollTop: Math.round(scrollRef.current?.scrollTop ?? 0) });
					}, 300);
				};
				const el = scrollRef.current;
				el?.addEventListener('scroll', save, { passive: true });
				save();
				return () => { el?.removeEventListener('scroll', save); clearTimeout(timer); };
			}, [natural, scale, rotation, fitMode]);

			// effective scale under fit modes (rotation-aware)
			const effective = useMemo(() => {
				if (!natural) return 1;
				if (!fitMode) return scale;
				const swapped = rotation % 180 !== 0;
				const w = swapped ? natural.height : natural.width;
				const hSwapped = swapped ? natural.width : natural.height;
				const el = scrollRef.current;
				const viewportWidth = Math.max((el?.clientWidth ?? 800) - 76, 1);
				const viewportHeight = Math.max((el?.clientHeight ?? 600) - 76, 1);
				if (fitMode === 'width') return clamp(viewportWidth / Math.max(w, 1), 0.1, 8);
				return clamp(Math.min(viewportWidth / Math.max(w, 1), viewportHeight / Math.max(hSwapped, 1)), 0.1, 8);
			}, [natural, fitMode, rotation, scale, viewportTick]);

			// stage sizing so transform overflow scrolls correctly
			const stageSize = useMemo(() => {
				if (!natural) return null;
				const swapped = rotation % 180 !== 0;
				const w = (swapped ? natural.height : natural.width) * effective;
				const h = (swapped ? natural.width : natural.height) * effective;
				return { width: Math.ceil(w), height: Math.ceil(h) };
			}, [natural, rotation, effective]);

			// The <img> keeps its NATURAL layout size and is scaled/rotated purely
			// visually, so the transform must anchor at the img's TOP-LEFT and
			// compensate rotation with a display-unit translate — anything else
			// (e.g. origin center) draws the picture around the layout box's
			// center, thousands of px right of the stage for large images
			// (invisible until scrolled: the "empty stage + h-scrollbar" bug).
			const imgTransform = useMemo(() => {
				if (!natural) return 'none';
				const s = effective;
				const px = (v) => `${Math.round(v * 100) / 100}px`;
				const w = natural.width * s, h = natural.height * s;
				if (rotation === 90) return `translate(${px(h)}, 0px) rotate(90deg) scale(${s})`;
				if (rotation === 180) return `translate(${px(w)}, ${px(h)}) rotate(180deg) scale(${s})`;
				if (rotation === 270) return `translate(0px, ${px(w)}) rotate(270deg) scale(${s})`;
				return `scale(${s})`;
			}, [natural, rotation, effective]);

			// ctrl wheel zoom
			useEffect(() => {
				const el = scrollRef.current;
				if (!el) return;
				let last = 0;
				const onWheel = (event) => {
					if (!(event.ctrlKey || event.metaKey)) return;
					event.preventDefault();
					const now = Date.now();
					if (now - last < 60) return;
					last = now;
					setFitMode(null);
					setScale((s) => clamp(Number((s + (event.deltaY < 0 ? 0.1 : -0.1)).toFixed(2)), 0.1, 8));
				};
				el.addEventListener('wheel', onWheel, { passive: false });
				return () => el.removeEventListener('wheel', onWheel);
			}, []);

			const reset = () => { setScale(1); setRotation(0); setFitMode(null); };
			const isDefault = fitMode === null && rotation === 0 && Math.abs(scale - 1) < 0.001;

			if (error) return h('div', { className: 'dr-error' }, `${t('panel.error')}: ${error}`);
			return h(React.Fragment, null,
				h(ViewBar, null,
					h(Btn, { title: t('panel.zoomOut'), onClick: () => { setFitMode(null); setScale((s) => clamp(Number((s - 0.1).toFixed(2)), 0.1, 8)); }, disabled: !natural || effective <= 0.1 + 1e-9 }, '−'),
					h('span', { className: 'dr-badge' }, `${Math.round(effective * 100)}%`),
					h(Btn, { title: t('panel.zoomIn'), onClick: () => { setFitMode(null); setScale((s) => clamp(Number((s + 0.1).toFixed(2)), 0.1, 8)); }, disabled: !natural || effective >= 8 - 1e-9 }, '+'),
					h(Btn, { title: t('panel.zoomReset'), onClick: reset, disabled: !natural || isDefault }, '100%'),
					h(Btn, { title: t('panel.rotateLeft'), onClick: () => setRotation((r) => (r + 270) % 360), disabled: !natural }, '↺'),
					h(Btn, { title: t('panel.rotateRight'), onClick: () => setRotation((r) => (r + 90) % 360), disabled: !natural }, '↻'),
					h(Btn, { title: t('panel.fitWindow'), onClick: () => setFitMode('window'), pressed: fitMode === 'window', disabled: !natural }, t('panel.fitWindow')),
					h(Btn, { title: t('panel.fitWidth'), onClick: () => setFitMode('width'), pressed: fitMode === 'width', disabled: !natural }, t('panel.fitWidth'))),
				h('div', { className: 'dr-stage' },
					h('div', { className: 'dr-scroll', ref: scrollRef },
						h('div', { className: 'dr-image-host' },
							h('div', { className: 'dr-image-stage', ref: stageRef, style: stageSize ? { width: `${stageSize.width + 29}px`, height: `${stageSize.height + 29}px` } : undefined },
								h('img', {
									src: downsampled ?? FILE_URL(path), alt: path, decoding: 'async',
									onLoad: async (e) => {
										const img = e.currentTarget;
										const width = img.naturalWidth;
										const height = img.naturalHeight;
										// giant bitmaps (>8192px) can request GB-scale decode memory: downsample once
										if ((width > 8192 || height > 8192) && !downsampledRef.current) {
										const token = dsTokenRef.current;
											try {
												const ratio = Math.min(1, 8192 / Math.max(width, height));
												const bmp = await createImageBitmap(img, { resizeWidth: Math.max(1, Math.round(width * ratio)), resizeHeight: Math.max(1, Math.round(height * ratio)), resizeQuality: 'good' });
												const canvas = document.createElement('canvas');
												canvas.width = bmp.width; canvas.height = bmp.height;
												canvas.getContext('2d').drawImage(bmp, 0, 0);
												bmp.close?.();
												const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
												if (blob) {
													const url = URL.createObjectURL(blob);
													if (token !== dsTokenRef.current) { URL.revokeObjectURL(url); return; } // stale: user moved on
													downsampledRef.current = url;
													setDownsampled(url); // reloads <img> at display size; onLoad fires again
													return;
												}
											} catch { /* keep the original image */ }
										}
										setNatural({ width: img.naturalWidth, height: img.naturalHeight });
										// restore the scroll offset only now that layout has real height
										const pending = pendingScrollRef.current;
										if (pending !== null) {
											pendingScrollRef.current = null;
											requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = pending; });
										}
									},
									onError: () => setError('image failed to load'),
									style: {
										width: natural ? `${natural.width}px` : undefined,
										height: natural ? `${natural.height}px` : undefined,
										transform: imgTransform,
										opacity: natural ? 1 : 0,
									},
								}))))));
		}

		// ---------- sanitized HTML / EPUB rendering ----------
// URL parsers strip NUL..space and DEL before scheme detection, so a raw
// /^javascript:/ test misses "java\tscript:" — normalize first, then decide
// by scheme instead of by deny-list.
function docUrlKind(value) {
	const norm = (value || '').replace(/[\x00-\x20\x7f]/gu, '');
	if (!norm) return 'none';
	if (norm.startsWith('#')) return 'anchor';
	if (/^[a-z][a-z0-9+.\-]*:/iu.test(norm)) {
		if (/^data:image\//iu.test(norm)) return 'inline-image';
		try {
			const { protocol } = new URL(norm);
			if (protocol === 'http:' || protocol === 'https:') return 'external';
			if (protocol === 'blob:') return 'asset'; // page-local blob we created ourselves
			return 'blocked';
		} catch {
			return 'blocked';
		}
	}
	return 'relative';
}

const SANITIZE_REMOVE = 'script,iframe,object,embed,link,meta,base,form,video,audio,source,track,picture,style';
/** Strip executable content and any remote-request surface from a fragment:
 * dangerous elements, on* handlers, non-http(s) absolute URLs, srcset/poster
 * beacons. Also descends into <template> content. */
function sanitizeFragment(root) {
	root.querySelectorAll(SANITIZE_REMOVE).forEach((el) => el.remove());
	const clean = (scope) => {
		for (const el of scope.querySelectorAll('*')) {
			for (const attr of [...el.attributes]) {
				const name = attr.name.toLowerCase();
				const value = attr.value;
				if (name.startsWith('on')) { el.removeAttribute(attr.name); continue; }
				if (name === 'srcset' || name === 'poster' || name === 'loading') { el.removeAttribute(attr.name); continue; }
				if (name === 'href' || name === 'src' || name === 'xlink:href') {
					const kind = docUrlKind(value);
					if (kind === 'blocked' || kind === 'none') el.removeAttribute(attr.name);
				}
			}
			if ((el.localName || el.tagName || '').toLowerCase() === 'a') {
				el.setAttribute('target', '_blank');
				el.setAttribute('rel', 'noopener noreferrer');
			}
		}
		for (const tpl of scope.querySelectorAll('template')) clean(tpl.content);
	};
	clean(root);
}

/**
 * Whitelisted click guard for sanitized containers: external -> system
 * browser, anchors -> smooth scroll, supported relative docs -> open in the
 * reader, everything else blocked (never falls through to default nav).
 */
function useGuardedLinks(ref, enabled, opts = {}) {
	const { onOpen, dir } = opts;
	const onOpenRef = useRef(onOpen);
	onOpenRef.current = onOpen;
	useEffect(() => {
		const root = ref.current;
		if (!root || !enabled) return undefined;
		const onClick = (event) => {
			const anchor = event.target.closest('a[href]');
			if (!anchor) return;
			const href = anchor.getAttribute('href') || '';
			const kind = docUrlKind(href);
			event.preventDefault(); // navigation is opt-in only
			if (kind === 'external') { window.open(href, '_blank', 'noopener,noreferrer'); return; }
			if (kind === 'anchor') {
				let id = href.slice(1);
				try { id = decodeURIComponent(id); } catch { /* keep raw */ }
				root.querySelector(`[id="${CSS.escape(id)}"], a[name="${CSS.escape(id)}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
				return;
			}
			if (kind === 'relative' && onOpenRef.current && dir) {
				const resolved = joinDir(dir, href);
				if (resolved && kindOf(resolved)) { onOpenRef.current(resolved); return; }
			}
		};
		root.addEventListener('click', onClick);
		return () => root.removeEventListener('click', onClick);
	}, [enabled, dir]);
}

function FontControls({ t, fontSize, setFontSize, settings }) {
	return h(React.Fragment, null,
		h(Btn, { title: t('panel.fontSmaller'), onClick: () => setFontSize((s) => Math.max(10, s - 1)) }, 'A−'),
		h('span', { className: 'dr-badge' }, `${fontSize}px`),
		h(Btn, { title: t('panel.fontBigger'), onClick: () => setFontSize((s) => Math.min(40, s + 1)) }, 'A+'),
		h(Btn, { title: t('panel.fontReset'), onClick: () => setFontSize(settings.fontSize) }, 'A'));
}

		/** Local .html/.htm file: parsed, sanitized, images routed through the file endpoint. */
		function HtmlView({ path, settings, t, onStatus, onSidebar, sidebar }) {
			const [state, setState] = useState({ status: 'loading' });
			const [fontSize, setFontSize] = useState(() => {
				const pos = getPos(path);
				return (pos && pos.kind === 'html' && typeof pos.fontSize === 'number') ? pos.fontSize : settings.fontSize;
			});
			const [query, setQuery] = useState('');
			const [count, setCount] = useState(0);
			const [index, setIndex] = useState(-1);
			const bodyRef = useRef(null);
			const scrollRef = useRef(null);
			const search = useDomSearch(bodyRef, (total, idx) => { setCount(total); setIndex(idx); }, onStatus, t);
			const dir = useMemo(() => path.slice(0, path.lastIndexOf('/')) || '/', [path]);
			useScrollRestore(path, scrollRef, () => ({ kind: 'html', fontSize }), state.status === 'ready');
			useGuardedLinks(bodyRef, state.status === 'ready');
			useEffect(() => {
				let alive = true; setState({ status: 'loading' }); onSidebar(null);
				const controller = new AbortController();
				fetchFile(path, 'text', controller.signal).then((html) => {
					if (!alive) return;
					const doc = new DOMParser().parseFromString(html, 'text/html');
					const body = doc.body;
					for (const img of [...body.querySelectorAll('img[data-src]')]) {
						img.setAttribute('src', img.getAttribute('data-src') || '');
						img.removeAttribute('data-src');
					}
					for (const img of [...body.querySelectorAll('img[src]')]) {
						const raw = img.getAttribute('src') || '';
						const kind = docUrlKind(raw);
						const resolved = kind === 'relative' ? joinDir(dir, raw) : null;
						if (resolved && kindOf(resolved) === 'image') { img.setAttribute('src', FILE_URL(resolved)); img.setAttribute('loading', 'lazy'); }
						else if (kind === 'inline-image') { img.setAttribute('loading', 'lazy'); } // keep data:image/*
						else img.removeAttribute('src');
					}
					body.querySelectorAll('[srcset]').forEach((el) => el.removeAttribute('srcset'));
					sanitizeFragment(body);
					setState({ status: 'ready', html: body.innerHTML });
				}).catch((e) => { if (alive && e?.name !== 'AbortError') setState({ status: 'error', message: e.message }); });
				return () => { alive = false; controller.abort(); };
			}, [path]);
			if (state.status === 'error') return h('div', { className: 'dr-error' }, `${t('panel.error')}: ${state.message}`);
			if (state.status !== 'ready') return h('div', { className: 'dr-load' }, t('panel.loading'));
			return h(React.Fragment, null,
				h(ViewBar, null,
					h(SearchControls, { t, query, setQuery, count, index,
						onEnter: (dirn) => (query.trim() ? search.run(query, dirn) : search.clear()),
						onPrev: () => search.navigate(-1), onNext: () => search.navigate(1) }),
						h('span', { style: { flex: 1 } }),
						h(FontControls, { t, fontSize, setFontSize, settings })),
				h('div', { className: 'dr-stage', style: { '--dr-line-height': settings.lineHeight } },
					sidebar,
					h('div', { className: 'dr-scroll', ref: scrollRef },
						h('article', { className: 'dr-md', ref: bodyRef, style: { fontSize: `${fontSize}px` }, dangerouslySetInnerHTML: { __html: state.html } })),
				h(SaveFontSize, { path, kind: 'html', fontSize })));
		}

		const resolveZipPath = (baseDir, ref) => {
	const clean = (ref || '').split('?')[0].split('#')[0];
	if (!clean) return null;
	let decoded = clean;
	try { decoded = decodeURIComponent(clean); } catch { /* keep raw */ }
	const parts = baseDir ? baseDir.split('/') : [];
	for (const seg of decoded.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') parts.pop();
		else parts.push(seg);
	}
	return parts.join('/');
};

const EPUB_MAX_CHAPTER_BYTES = 20 * 1024 * 1024;
const EPUB_MAX_IMAGE_BYTES = 50 * 1024 * 1024;

/** Case-tolerant zip lookup: zip entries are case-sensitive but Windows-made
 * epubs frequently disagree with the OPF about it. */
function zipEntry(book, name) {
	if (!name) return null;
	const hit = book.zip.file(name);
	if (hit) return hit;
	if (!book.lowerMap) {
		book.lowerMap = new Map();
		book.zip.forEach((relPath, file) => { if (!book.lowerMap.has(relPath.toLowerCase())) book.lowerMap.set(relPath.toLowerCase(), file); });
	}
	return book.lowerMap.get(name.toLowerCase()) ?? null;
}

async function parseEpub(vendor, buf) {
	const zip = await vendor.JSZip.loadAsync(buf);
	const book = { zip, opfDir: '', spine: [], titles: [], spinePaths: [] };
	const containerRaw = decodeText(await zipEntry(book, 'META-INF/container.xml')?.async('uint8array').then((b) => b ?? new Uint8Array()));
	const container = new DOMParser().parseFromString(containerRaw ?? '', 'application/xml');
	let opfPath = [...container.getElementsByTagName('*')].find((n) => n.localName === 'rootfile')?.getAttribute('full-path') ?? '';
	try { opfPath = decodeURIComponent(opfPath); } catch { /* keep raw */ }
	opfPath = opfPath.replace(/^\/+/u, '');
	const opfEntry = zipEntry(book, opfPath);
	if (!opfPath || !opfEntry) throw new Error('epub: missing OPF');
	book.opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : '';
	const opf = new DOMParser().parseFromString(decodeText(await opfEntry.async('uint8array')), 'application/xml');
	const manifest = new Map();
	for (const item of opf.getElementsByTagName('*')) {
		if (item.localName !== 'item') continue;
		manifest.set(item.getAttribute('id'), {
			href: item.getAttribute('href') || '',
			type: item.getAttribute('media-type') || '',
			properties: item.getAttribute('properties') || '',
		});
	}
	book.spine = [...opf.getElementsByTagName('*')].filter((n) => n.localName === 'itemref')
		.map((n) => manifest.get(n.getAttribute('idref')))
		.filter((it) => it && /x?html/i.test(it.type));
	if (book.spine.length === 0) throw new Error('epub: empty spine');
	// materialize resolved paths once (TOC matching is O(n+m) this way)
	book.spinePaths = book.spine.map((it) => resolveZipPath(book.opfDir, it.href));
	// chapter titles: EPUB3 nav document, else NCX navLabel>text, else positional
	book.titles = new Array(book.spine.length).fill('');
	const tocItem = [...manifest.values()].find((it) => it.properties.split(' ').includes('nav'))
		?? [...manifest.values()].find((it) => it.type === 'application/x-dtbncx+xml');
	if (tocItem) {
		const tocPath = resolveZipPath(book.opfDir, tocItem.href);
		const tocEntry = zipEntry(book, tocPath);
		if (tocEntry) {
			const tocDoc = new DOMParser().parseFromString(decodeText(await tocEntry.async('uint8array')), 'application/xml');
			const entries = tocItem.type === 'application/x-dtbncx+xml'
				? [...tocDoc.getElementsByTagName('*')].filter((n) => n.localName === 'navPoint').map((n) => {
					const labelNode = [...n.getElementsByTagName('*')].find((a) => a.localName === 'navLabel');
					const textNode = labelNode ? [...labelNode.getElementsByTagName('*')].find((a) => a.localName === 'text') : null;
					const srcNode = [...n.getElementsByTagName('*')].find((a) => a.localName === 'content');
					return { href: srcNode?.getAttribute('src') || '', text: (textNode?.textContent || '').trim() };
				})
				: [...tocDoc.getElementsByTagName('*')].filter((n) => n.localName === 'a' && n.getAttribute('href'))
					.map((n) => ({ href: n.getAttribute('href'), text: (n.textContent || '').trim() }));
			const tocDir = tocPath.includes('/') ? tocPath.slice(0, tocPath.lastIndexOf('/')) : '';
			for (const entry of entries) {
				const target = resolveZipPath(tocDir, entry.href);
				const idx = book.spinePaths.indexOf(target);
				if (idx >= 0 && !book.titles[idx]) book.titles[idx] = entry.text;
			}
		}
	}
	book.titles = book.titles.map((title, i) => title || `${i + 1}`);
	return book;
}

/** Render one chapter. Returns { html, urls }; the CALLER owns the blob URLs. */
	const EPUB_MAX_CSS_BYTES = 512 * 1024;
	const CSS_MIME = { '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

	/** Prefix every plain rule with the chapter scope so book styles can never
	 * leak into the reader chrome; @media recurses, @import is dropped,
	 * font-face/keyframes pass through untouched. */
	function scopeEpubCss(css, scope) {
		// blockless at-statements (@import/@charset) have no '{' — strip them up
		// front or the parser would glue them onto the next rule's block
		css = css.replace(/@(?:import|charset)[^;{}]*;?/giu, '');
		let out = '';
		let i = 0;
		const n = css.length;
		while (i < n) {
			const brace = css.indexOf('{', i);
			if (brace < 0) { out += css.slice(i); break; }
			const sel = css.slice(i, brace);
			let depth = 1;
			let j = brace + 1;
			while (j < n && depth > 0) {
				if (css[j] === '{') depth += 1;
				else if (css[j] === '}') depth -= 1;
				j += 1;
			}
			const block = css.slice(brace + 1, j - 1);
			const trimmed = sel.trim();
			if (trimmed.startsWith('@')) {
				const at = trimmed.replace(/^(@[\w-]+).*$/su, '$1').toLowerCase();
				if (at === '@import') { /* dropped: no nested fetching */ }
				else if (at === '@media' || at === '@supports') out += `${sel}{${scopeEpubCss(block, scope)}}`;
				else out += `${sel}{${block}}`;
			} else if (trimmed) {
				const scoped = trimmed.split(',').map((part) => {
					const p = part.trim();
					if (!p) return p;
					if (/^(body|html)$/iu.test(p)) return `.${scope}`;
					if (/^(body|html)([ .#:[])/iu.test(p)) return `.${scope}${p.replace(/^(body|html)/iu, '')}`;
					return `.${scope} ${p}`;
				}).filter(Boolean).join(', ');
				if (scoped) out += `${scoped}{${block}}`;
			}
			i = j;
		}
		return out;
	}

	/** Rewrite url(...) references in chapter CSS to blob URLs from the zip
	 * (embedded fonts and decorative images); collected into `urls` for the
	 * caller's revoke lifecycle. */
	async function rewriteEpubCssUrls(cssText, book, chapterDir, urls) {
		const seen = new Map();
		const jobs = [];
		for (const m of cssText.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gu)) {
			const raw = m[2];
			if (!raw || /^(data:|https?:|blob:|#)/iu.test(raw)) continue;
			const clean = raw.split('?')[0].split('#')[0];
			const target = clean ? resolveZipPath(chapterDir, clean) : null;
			if (!target || seen.has(target)) continue;
			const entry = zipEntry(book, target);
			if (!entry || (entry._data?.uncompressedSize ?? 0) > EPUB_MAX_IMAGE_BYTES) { seen.set(target, null); continue; }
			seen.set(target, null);
			jobs.push(entry.async('uint8array').then((u8) => {
				const ext = target.slice(target.lastIndexOf('.')).toLowerCase();
				const blob = new Blob([u8], { type: CSS_MIME[ext] ?? 'application/octet-stream' });
				const url = URL.createObjectURL(blob);
				urls.push(url);
				cssText = cssText.split(m[0]).join(`url(${url})`);
			}).catch(() => {}));
		}
		await Promise.all(jobs);
		return cssText;
	}

	/** Cheap whole-book hit scan: which spine chapters contain the query. */
	async function epubChapterHas(book, needle) {
		const lower = needle.toLowerCase();
		const flags = [];
		for (let i = 0; i < book.spinePaths.length; i++) {
			const entry = zipEntry(book, book.spinePaths[i]);
			let has = false;
			if (entry && (entry._data?.uncompressedSize ?? 0) <= EPUB_MAX_CHAPTER_BYTES) {
				try { has = decodeText(await entry.async('uint8array')).toLowerCase().includes(lower); } catch { has = false; }
			}
			flags.push(has);
		}
		return flags;
	}

async function renderEpubChapter(book, index) {
	const chapterPath = book.spinePaths[index];
	const entry = zipEntry(book, chapterPath);
	if (!entry) throw new Error(`epub: chapter ${index + 1} missing`);
	const rawSize = entry._data?.uncompressedSize ?? 0;
	if (rawSize > EPUB_MAX_CHAPTER_BYTES) throw new Error(`epub: chapter ${index + 1} too large`);
	const raw = decodeText(await entry.async('uint8array'));
	// XHTML is strict; real-world books often have one unclosed tag — fall back
	let doc = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
	let body = doc.getElementsByTagName('body')[0] ?? doc.body;
	if (!body) { // malformed OR fragment-only chapter: the HTML parser synthesizes <body>
		doc = new DOMParser().parseFromString(raw, 'text/html');
		body = doc.getElementsByTagName('body')[0] ?? doc.body;
	}
	if (!body) throw new Error(`epub: chapter ${index + 1} has no body`);
	const chapterDir = chapterPath.includes('/') ? chapterPath.slice(0, chapterPath.lastIndexOf('/')) : '';
	const urls = [];
	// chapter stylesheets: <link rel=stylesheet> from the zip + inline <style>,
	// scoped to the chapter container and with url() assets inlined as blobs
	let css = '';
	const head = doc.getElementsByTagName('head')[0];
	const cssParts = [];
	if (head) {
		for (const link of [...head.querySelectorAll('link[href]')]) {
			const rel = (link.getAttribute('rel') || '').split(/\s+/u).map((r) => r.toLowerCase());
			if (!rel.includes('stylesheet')) continue;
			const target = resolveZipPath(chapterDir, link.getAttribute('href') || '');
			const cssEntry = target ? zipEntry(book, target) : null;
			if (!cssEntry || (cssEntry._data?.uncompressedSize ?? 0) > EPUB_MAX_CSS_BYTES) continue;
			cssParts.push(decodeText(await cssEntry.async('uint8array')));
		}
		for (const style of [...head.querySelectorAll('style')]) cssParts.push(style.textContent || '');
	}
	if (cssParts.length) {
		let joined = cssParts.join('\n\n').slice(0, 2 * EPUB_MAX_CSS_BYTES);
		joined = await rewriteEpubCssUrls(joined, book, chapterDir, urls);
		css = scopeEpubCss(joined, 'dr-epub-ch').replace(/<\/style/giu, '<\\/style');
	}
	// normalize data-src lazy-loading so those images enter the rewrite path
	for (const img of [...body.querySelectorAll('img[data-src], image[data-src]')]) {
		img.setAttribute('src', img.getAttribute('data-src') || '');
		img.removeAttribute('data-src');
	}
	for (const img of [...body.querySelectorAll('img[src], image[href], image[xlink\\:href]')]) {
		const attr = img.hasAttribute('src') ? 'src' : (img.hasAttribute('href') ? 'href' : 'xlink:href');
		const kind = docUrlKind(img.getAttribute(attr) || '');
		if (kind !== 'relative') continue; // inline/remote handled by sanitize
		const target = resolveZipPath(chapterDir, img.getAttribute(attr) || '');
		const imgEntry = target ? zipEntry(book, target) : null;
		if (imgEntry) {
			if ((imgEntry._data?.uncompressedSize ?? 0) > EPUB_MAX_IMAGE_BYTES) { img.removeAttribute(attr); continue; }
			const blob = await imgEntry.async('blob');
			const url = URL.createObjectURL(blob);
			urls.push(url);
			img.setAttribute('src', url); // normalize xlink:href -> src for the HTML context
			img.removeAttribute('xlink:href');
			img.removeAttribute('href');
		} else img.removeAttribute(attr);
	}
	sanitizeFragment(body);
	return { html: body.innerHTML, urls, css };
}

function EpubView({ path, settings, t, onStatus, onSidebar, sidebar, onOpen }) {
	const [fatal, setFatal] = useState(null); // whole book unreadable
	const [chapterError, setChapterError] = useState(null); // this chapter only
	const [book, setBook] = useState(null);
	const [chapter, setChapter] = useState(() => {
		const pos = getPos(path);
		return pos?.kind === 'epub' && Number.isInteger(pos.chapter) && pos.chapter >= 0 ? pos.chapter : 0;
	});
	const [html, setHtml] = useState(null);
	const [fontSize, setFontSize] = useState(() => {
		const pos = getPos(path);
		return (pos && pos.kind === 'epub' && typeof pos.fontSize === 'number') ? pos.fontSize : settings.fontSize;
	});
	const [query, setQuery] = useState('');
	const [count, setCount] = useState(0);
	const [index, setIndex] = useState(-1);
	const [css, setCss] = useState('');
	const bodyRef = useRef(null);
	const bookRef = useRef(null);
	bookRef.current = book;
	const countRef = useRef(0);
	const hitIndexRef = useRef(-1);
	const pendingSearchRef = useRef(null); // { query, dirn } to run after a chapter hop
	const scrollRef = useRef(null);
	const blobUrlsRef = useRef([]);
	const chapterRef = useRef(chapter);
	chapterRef.current = chapter;
	const search = useDomSearch(bodyRef, (total, idx) => { countRef.current = total; hitIndexRef.current = idx; setCount(total); setIndex(idx); }, onStatus, t);
	useGuardedLinks(bodyRef, !!html, { onOpen, dir: '' });
	useScrollRestore(path, scrollRef, () => ({ kind: 'epub', fontSize, chapter: chapterRef.current }), !!html);

	// load book structure
	useEffect(() => {
		let alive = true; setFatal(null); setBook(null); setChapter(0); setHtml(null); setChapterError(null); onSidebar(null);
		blobUrlsRef.current = [];
		const controller = new AbortController();
		Promise.all([loadVendor(), fetchFile(path, undefined, controller.signal)])
			.then(async ([vendor, buf]) => {
				const parsed = await parseEpub(vendor, buf);
				if (alive) setBook(parsed);
			})
			.catch((e) => { if (alive && e?.name !== 'AbortError') setFatal(e.message); });
		return () => { alive = false; controller.abort(); onSidebar(null); };
	}, [path]);

	// render the current chapter
	useEffect(() => {
		if (!book) return undefined;
		let alive = true;
		const prevUrls = blobUrlsRef.current;
		blobUrlsRef.current = [];
		setChapterError(null);
		setHtml(null);
		setCount(0);
		setIndex(-1);
		renderEpubChapter(book, chapter)
			.then(({ html: out, urls, css: chapterCss }) => {
				if (!alive) { for (const u of urls) URL.revokeObjectURL(u); return; }
				for (const u of prevUrls) URL.revokeObjectURL(u); // old chapter's images die only once replaced
				blobUrlsRef.current = urls;
				setCss(chapterCss || '');
				setHtml(out);
			})
			.catch((e) => { if (alive) setChapterError(e?.message ?? String(e)); });
		return () => { alive = false; };
	}, [book, chapter]);

	// revoke everything on unmount / path switch
	useEffect(() => () => {
		for (const u of blobUrlsRef.current) URL.revokeObjectURL(u);
		blobUrlsRef.current = [];
	}, []);

	// a chapter hop for whole-book search lands here: run the query in the
	// freshly rendered chapter once its DOM exists
	useEffect(() => {
		const pending = pendingSearchRef.current;
		if (!html || !pending) return;
		pendingSearchRef.current = null;
		search.run(pending.query, pending.dirn);
		if (countRef.current > 0 && bookRef.current) {
			const title = bookRef.current.titles?.[chapterRef.current] || String(chapterRef.current + 1);
			onStatus(`${t('panel.searchJumped')}: ${title} · ${countRef.current}`);
		}
	}, [html]);

	// whole-book search: a miss or a boundary in this chapter hops to the next
	// chapter that contains the query
	const runSearch = async (dirn) => {
		const q = query.trim();
		if (!q) { search.clear(); countRef.current = 0; return; }
		search.run(q, dirn);
		if (countRef.current > 0) return;
		if (!bookRef.current) return;
		const flags = await epubChapterHas(bookRef.current, q);
		const n = flags.length;
		let next = -1;
		for (let step = 1; step <= n; step++) { const i = (chapterRef.current + step) % n; if (flags[i]) { next = i; break; } }
		if (next >= 0) { pendingSearchRef.current = { query: q, dirn }; setChapter(next); }
	};
	const navSearch = async (dir) => {
		if (countRef.current === 0) return;
		if (dir > 0 && hitIndexRef.current < countRef.current - 1) return search.navigate(1);
		if (dir < 0 && hitIndexRef.current > 0) return search.navigate(-1);
		const q = query.trim();
		if (!q || !bookRef.current) return search.navigate(dir);
		const flags = await epubChapterHas(bookRef.current, q);
		const n = flags.length;
		let next = -1;
		for (let step = 1; step <= n; step++) { const i = ((chapterRef.current + dir * step) % n + n) % n; if (flags[i]) { next = i; break; } }
		if (next >= 0 && next !== chapterRef.current) { pendingSearchRef.current = { query: q, dirn: dir }; setChapter(next); }
		else search.navigate(dir); // wrap inside this chapter
	};

	// chapter sidebar
	useEffect(() => {
		if (!book) return undefined;
		onSidebar({
			kind: 'outline',
			items: book.titles.map((title, i) => ({ level: 1, text: `${i + 1}. ${title}`, id: `ch-${i}` })),
			go: (id) => { const i = Number(String(id).slice(3)); if (Number.isInteger(i) && i >= 0 && i < book.spine.length) setChapter(i); },
		});
		return () => onSidebar(null);
	}, [book]);

	if (fatal) return h('div', { className: 'dr-error' }, `${t('panel.error')}: ${fatal}`);
	if (!book) return h('div', { className: 'dr-load' }, t('panel.loading'));
	return h(React.Fragment, null,
		h(ViewBar, null,
			h(SearchControls, { t, query, setQuery, count, index,
				onEnter: (dirn) => { void runSearch(dirn); },
				onPrev: () => { void navSearch(-1); }, onNext: () => { void navSearch(1); } }),
			h('span', { style: { flex: 1 } }),
			h('span', { className: 'dr-badge' }, `${chapter + 1}/${book.spine.length}`),
			h(Btn, { title: t('panel.prevPage'), onClick: () => setChapter((c) => Math.max(0, c - 1)), disabled: chapter <= 0 }, '‹'),
			h(Btn, { title: t('panel.nextPage'), onClick: () => setChapter((c) => Math.min(book.spine.length - 1, c + 1)), disabled: chapter >= book.spine.length - 1 }, '›'),
			h(FontControls, { t, fontSize, setFontSize, settings })),
		h('div', { className: 'dr-stage', style: { '--dr-line-height': settings.lineHeight } },
			sidebar,
			h('div', { className: 'dr-scroll', ref: scrollRef },
				chapterError
					? h('div', { className: 'dr-error' }, `${t('panel.error')}: ${chapterError}`)
					: html
						? h('article', { className: `dr-md dr-epub-ch`, ref: bodyRef, style: { fontSize: `${fontSize}px` }, dangerouslySetInnerHTML: { __html: (css ? `<style>${css}</style>` : '') + html } })
						: h('div', { className: 'dr-load' }, t('panel.loading')))),
		h(SaveFontSize, { path, kind: 'epub', fontSize }));
}

		// ---------- content sidebar (outline / page list) ----------
		/** Virtualized page-number list: only the visible window of buttons is
		 * mounted, so a 2000-page PDF re-renders ~30 rows on page change. */
		function PageList({ model, t }) {
			const ROW = 26;
			const scrollRef = useRef(null);
			const [scrollTop, setScrollTop] = useState(0);
			const [viewportH, setViewportH] = useState(400);
			useEffect(() => {
				const el = scrollRef.current;
				if (el) setViewportH(el.clientHeight || 400);
			}, []);
			useEffect(() => {
				const el = scrollRef.current;
				if (el && model.currentPage > 0) {
					const target = (model.currentPage - 1) * ROW;
					if (target < el.scrollTop || target > el.scrollTop + el.clientHeight - ROW) {
						el.scrollTop = Math.max(0, target - el.clientHeight / 2);
					}
				}
			}, [model.currentPage]);
			const total = model.numPages;
			const first = Math.max(0, Math.floor(scrollTop / ROW) - 5);
			const last = Math.min(total, first + Math.ceil(viewportH / ROW) + 10);
			const btnStyle = (active) => ({ position: 'absolute', left: 0, right: 0, textAlign: 'left', background: active ? 'var(--dsw-alias-interactive-bg-hover)' : 'none', border: 'none', color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)', cursor: 'pointer', padding: '3px 8px', fontSize: '12px', fontFamily: 'inherit', lineHeight: 1.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRadius: '4px' });
			return h('div', {
				ref: scrollRef,
				onScroll: (e) => setScrollTop(e.currentTarget.scrollTop),
				style: { flex: '1 1 0', minHeight: 0, overflowY: 'auto', position: 'relative' },
			},
				h('div', { style: { height: `${total * ROW}px`, position: 'relative' } },
					Array.from({ length: last - first }, (_, i) => {
						const num = first + i + 1;
						return h('button', {
							key: num, style: { ...btnStyle(model.currentPage === num), top: `${(num - 1) * ROW}px`, height: `${ROW - 3}px` },
							onClick: () => model.go?.(num),
						}, `${t('panel.page')} ${num}`);
					})));
		}

		function ContentSidebar({ model, t, onCollapse }) {
			const [width, setWidth] = useState(() => {
				const saved = readJson(LS.tocWidth, 200);
				return Number.isFinite(saved) ? clamp(saved, 160, 480) : 200;
			});
			const widthRef = useRef(width);
			widthRef.current = width;
			const dragCleanupRef = useRef(null);
			const onHandleDown = (e) => {
				if (e.button !== 0) return;
				e.preventDefault();
				const startX = e.clientX;
				const startW = widthRef.current;
				const onMove = (ev) => { const w = clamp(startW + ev.clientX - startX, 160, 480); widthRef.current = w; setWidth(w); };
				const stop = () => {
					window.removeEventListener('mousemove', onMove);
					window.removeEventListener('mouseup', onUp);
					dragCleanupRef.current = null;
					writeJson(LS.tocWidth, widthRef.current);
				};
				dragCleanupRef.current = stop;
				window.addEventListener('mousemove', onMove);
				window.addEventListener('mouseup', onUp);
			};
			useEffect(() => () => { dragCleanupRef.current?.(); }, []);
			if (!model) return null;
			return h('aside', {
				'aria-label': t('panel.outline'),
				style: { width: `${width}px`, flex: 'none', minWidth: 0, boxSizing: 'border-box', display: 'flex', flexDirection: 'column', fontSize: '12px', background: 'var(--dsw-alias-bg-layer-1)', borderRight: '.5px solid var(--dsw-alias-border-l1)', position: 'relative' },
			},
			h('div', {
				'aria-label': t('panel.resizeSidebar'), title: t('panel.resizeSidebar'),
				onMouseDown: onHandleDown,
				style: { position: 'absolute', top: 0, bottom: 0, right: 0, width: '5px', cursor: 'col-resize', zIndex: 5 },
			}),
				h('div', { style: { position: 'relative', display: 'flex', alignItems: 'center', padding: '8px 6px 6px 6px', width: '100%', boxSizing: 'border-box', flex: 'none' } },
					h('span', { style: { fontSize: '11px', color: 'var(--dsw-alias-label-tertiary)', whiteSpace: 'nowrap', flex: 'none', paddingRight: '28px' } },
						model.kind === 'outline' ? t('panel.outline') : t('panel.pages')),
					onCollapse && h('button', {
						style: { position: 'absolute', right: '2px', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', padding: '2px 8px', borderRadius: '4px', fontSize: '13px', lineHeight: 1, display: 'inline-flex', alignItems: 'center' },
						title: t('panel.collapseSidebar'), onClick: onCollapse,
					}, '‹')),
				model.kind === 'outline'
					? h('div', { style: { flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '0 0 12px' } },
						model.items.map((item, i) => h('button', {
							key: `${item.id}-${i}`, title: item.text,
							style: { display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 'none', color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', padding: '3px 8px', fontSize: '12px', fontFamily: 'inherit', lineHeight: 1.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRadius: '4px', paddingLeft: `${6 + (item.level - 1) * 10}px` },
							onClick: () => (model.go
								? model.go(item.id)
								: document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })),
						}, item.text || '(?)')))
					: h(PageList, { model, t }));
		}

		// ---------- file browser / recent ----------
		function FileBrowser({ onOpen, t, version }) {
			const [dir, setDir] = useState(null);
			const [listing, setListing] = useState(null);
			const [err, setErr] = useState(null);
			useEffect(() => { let alive = true; setErr(null);
				const controller = new AbortController();
				fetch(LIST_URL(dir ?? ''), { signal: controller.signal })
					.then((r) => (r.ok ? r.json() : r.json().then((j) => Promise.reject(new Error(j.error)))))
					.then((data) => { if (alive) setListing(data); })
					.catch((e) => { if (alive && e.name !== 'AbortError') setErr(e.message); });
				return () => { alive = false; controller.abort(); };
			}, [dir, version]);
			const crumbs = useMemo(() => {
				if (!listing) return [];
				const parts = listing.path.split('/').filter(Boolean);
				return [{ name: '/', path: '/' }, ...parts.map((name, i) => ({ name, path: '/' + parts.slice(0, i + 1).join('/') }))];
			}, [listing]);
			const parent = listing && listing.path !== '/' ? (listing.path.replace(/\/[^/]+\/?$/u, '') || '/') : null;
			return h('div', { style: { display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 } },
				h('div', { className: 'dr-crumbs' },
					crumbs.map((c, i) => h(React.Fragment, { key: c.path },
						i > 0 && '› ',
						h('button', { className: 'dr-crumb', onClick: () => setDir(c.path) }, c.name))),
					err && h('span', { style: { color: 'var(--dsw-alias-label-primary)' } }, `⚠ ${err}`)),
				h('div', { className: 'dr-side-scroll' },
					parent && h('button', { className: 'dr-row', onClick: () => setDir(parent) },
						h('span', null, '↩ '), h('span', null, '..')),
					(listing?.entries ?? []).map((entry) => h('button', {
						key: entry.path, className: 'dr-row',
						onClick: () => (entry.directory ? setDir(entry.path) : onOpen(entry.path)),
						title: entry.path,
					},
						entry.directory ? Glyph.dir(14) : kindGlyph(kindOf(entry.path), 14),
						h('span', null, entry.name),
						!entry.directory && h('small', null, entry.size > 1048576 ? `${(entry.size / 1048576).toFixed(1)}M` : `${Math.max(1, Math.round(entry.size / 1024))}K`))),
					listing?.truncated && h('div', { className: 'dr-empty-side' }, t('panel.listTruncated')),
					err === null && listing !== null && listing.entries.length === 0 && h('div', { className: 'dr-empty-side' }, t('panel.emptyDir')),
					err === null && listing === null && h('div', { className: 'dr-empty-side' }, t('panel.loading'))));
		}

		// shared date formatter (avoids re-creating per row per render)
		const recentDateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit' });
		const RECENT_CHECK_TTL = 24 * 60 * 60 * 1000;

		/** Corrupt entries (non-array storage, missing path/at) must never crash
		 * the render — normalize on every read. */
		function readRecentSafe() {
			const raw = readJson(LS.recent, []);
			if (!Array.isArray(raw)) return [];
			return raw.filter((e) => e && typeof e.path === 'string' && Number.isFinite(e.at));
		}

		function RecentList({ onOpen, onFlash, settings, version, t }) {
			const [recent, setRecent] = useState(() => readRecentSafe());
			useEffect(() => {
				const list = readRecentSafe();
				setRecent(list);
				// prune entries whose file no longer exists (rename leftovers etc.);
				// re-check at most once a day per entry to avoid HEAD storms
				let alive = true;
				const stale = list.filter((e) => !e.checked || Date.now() - e.checked > RECENT_CHECK_TTL);
				if (stale.length === 0) return () => { alive = false; };
				Promise.all(stale.map(async (e) => {
					try { const r = await fetch(FILE_URL(e.path), { method: 'HEAD' }); return r.ok; }
					catch { return false; }
				})).then((results) => {
					if (!alive) return;
					const alivePaths = new Set(stale.filter((_, i) => results[i]).map((e) => e.path));
					const deadPaths = new Set(stale.filter((_, i) => !results[i]).map((e) => e.path));
					// re-read: the user may have edited the list while we probed;
					// remove only confirmed-dead entries, keep everything else
					const fresh = readRecentSafe();
					const next = fresh
						.filter((e) => !deadPaths.has(e.path))
						.map((e) => (alivePaths.has(e.path) ? { ...e, checked: Date.now() } : e));
					for (const dead of deadPaths) { removePos(dead); removeDraft(dead); }
					writeJson(LS.recent, next);
					setRecent(next);
				});
				return () => { alive = false; };
			}, [version]);
			const refresh = () => setRecent(readJson(LS.recent, []));
			const remove = (path) => {
				writeJson(LS.recent, readJson(LS.recent, []).filter((e) => e.path !== path));
				removePos(path);
				refresh();
			};
			const reveal = async (path) => {
				const res = await fetch(REVEAL_URL(path));
				if (!res.ok) {
					const detail = await res.json().catch(() => ({ error: res.statusText }));
					onFlash(detail.error || 'reveal failed');
				}
			};
			// instant hover tooltip: native `title` has a ~1s browser delay, which
			// reads as "broken" on 22px action buttons — see useTip for details.
			const { hoverProps, hide: hideTip } = useTip();
			return h('div', { className: 'dr-side-scroll' },
				recent.length === 0 && h('div', { className: 'dr-empty-side' }, t('panel.recentEmpty')),
				recent.slice(0, settings.recentLimit).map((e) => h('div', {
					key: e.path, className: 'dr-row', title: e.path,
					onClick: () => onOpen(e.path), role: 'button', tabIndex: 0,
					onKeyDown: (ev) => { if (ev.key === 'Enter') onOpen(e.path); },
				},
					kindGlyph(e.kind ?? kindOf(e.path), 14),
					h('span', null, e.path.slice(e.path.lastIndexOf('/') + 1)),
					h('small', null, recentDateFmt.format(new Date(e.at))),
					h('span', { className: 'dr-row-actions' },
						h('button', {
							'aria-label': t('panel.revealInFinder'), 'data-action': 'reveal',
							onClick: (ev) => { ev.stopPropagation(); hideTip(); void reveal(e.path); },
							...hoverProps(t('panel.revealInFinder')),
						}, Glyph.folder(12)),
						h('button', {
							'aria-label': t('panel.removeRecent'), 'data-action': 'remove',
							onClick: (ev) => { ev.stopPropagation(); hideTip(); remove(e.path); },
							...hoverProps(t('panel.removeRecent')),
						}, '✕')))),
				recent.length > 0 && h('button', {
					className: 'dr-row', style: { color: 'var(--dsw-alias-label-tertiary)' },
					onClick: () => { writeJson(LS.recent, []); refresh(); },
				}, h('span', null, '🗑 '), h('span', null, t('panel.clearRecent'))));
		}

		/** Modal directory browser: reuse FileBrowser inside an overlay dialog. */
		function BrowseOverlay({ t, version, onOpen, onClose }) {
			useEffect(() => {
				const onKey = (e) => { if (e.key === 'Escape') onClose(); };
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, [onClose]);
			return h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.32)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }, onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
				h('div', { style: { width: 'min(560px,86vw)', height: 'min(520px,80vh)', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: '10px', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,.3)', overflow: 'hidden' }, role: 'dialog', 'aria-label': t('panel.browse') },
					h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 14px', borderBottom: '.5px solid var(--dsw-alias-border-l2)', fontSize: '13px', fontWeight: 600, flex: 'none' } }, Glyph.folder(15), ' ', t('panel.browse')),
					h(FileBrowser, { onOpen, t, version }),
					h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', padding: '8px 12px', borderTop: '.5px solid var(--dsw-alias-border-l2)', flex: 'none' } },
						h(Btn, { title: t('panel.close'), onClick: onClose }, t('panel.close')))));
		}

		// ---------- editor pane (text / markdown edit mode) ----------
		function EditorPane({ value, onChange, onSave, busy, label, areaRef: externalRef }) {
			const localRef = useRef(null);
			const areaRef = externalRef ?? localRef;
			const linesRef = useRef(null);
			const saveRef = useRef(onSave);
			saveRef.current = onSave;
			useEffect(() => {
				const onKey = (e) => {
					if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') {
						e.preventDefault();
						saveRef.current?.();
					}
				};
				window.addEventListener('keydown', onKey);
				return () => window.removeEventListener('keydown', onKey);
			}, []);
			useEffect(() => {
				const el = areaRef.current;
				if (el) { el.focus(); const end = el.value.length; el.setSelectionRange(end, end); }
			}, []);
			const lineCount = useMemo(() => (value ? value.split('\n').length : 1), [value]);
			const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount]);
			return h('div', { className: 'dr-editor-shell' },
				h('pre', { ref: linesRef, className: 'dr-editor-lines', 'aria-hidden': true }, numbers),
				h('textarea', {
					ref: areaRef, className: 'dr-editor', value, spellCheck: false, disabled: busy,
					'aria-label': label,
					onChange: (e) => onChange(e.target.value),
					onScroll: () => { if (linesRef.current && areaRef.current) linesRef.current.scrollTop = areaRef.current.scrollTop; },
				}));
		}

		/** In-editor find: textarea has no live highlight, so matches are
		 * selected and scrolled into view instead. */
		function useEditorSearch(text) {
			const areaRef = useRef(null);
			const [count, setCount] = useState(0);
			const [index, setIndex] = useState(-1);
			const indexRef = useRef(-1);
			const positionsRef = useRef([]);
			const needleRef = useRef('');
			const textRef = useRef(text);
			if (textRef.current !== text) { // draft edited after a search: offsets are stale
				textRef.current = text;
				positionsRef.current = [];
				needleRef.current = '';
				indexRef.current = -1;
				if (count !== 0) { setCount(0); setIndex(-1); }
			}
			const measureTop = (el, at) => measureTextareaTop(el, text, at);
			const focusMatch = (i) => {
				const el = areaRef.current;
				const positions = positionsRef.current;
				if (!el || !positions.length) return;
				const total = positions.length;
				const normalized = ((i % total) + total) % total;
				const at = positions[normalized];
				const len = needleRef.current.length;
				el.focus();
				el.setSelectionRange(at, at + len);
				const measured = measureTop(el, at);
				if (measured !== null) el.scrollTop = Math.max(0, Math.round(measured - el.clientHeight / 2));
				else {
					const line = (text.slice(0, at).match(/\n/g) ?? []).length;
					const style = getComputedStyle(el);
					const lineH = parseFloat(style.lineHeight) || 22;
					el.scrollTop = Math.max(0, Math.round(line * lineH - el.clientHeight / 2));
				}
				indexRef.current = normalized;
				setIndex(normalized);
			};
			const run = (query, dir) => {
				const needle = query.trim().toLowerCase();
				if (!needle || !text) { positionsRef.current = []; setCount(0); setIndex(-1); indexRef.current = -1; return; }
				const hay = text.toLowerCase();
				const positions = [];
				let at = hay.indexOf(needle);
				while (at >= 0 && positions.length < 5000) { positions.push(at); at = hay.indexOf(needle, at + needle.length); }
				positionsRef.current = positions;
				needleRef.current = needle;
				setCount(positions.length);
				focusMatch(dir < 0 ? positions.length - 1 : 0);
			};
			const navigate = (dir) => focusMatch((indexRef.current < 0 ? 0 : indexRef.current + dir));
			return { areaRef, count, index, run, navigate };
		}

		/** Shared edit-mode state machine for text/markdown viewers. */
		function useEditMode({ path, currentText, onSaved, t, onStatus }) {
			const [editing, setEditing] = useState(false);
			const [draft, setDraft] = useState('');
			const [busy, setBusy] = useState(false);
			const baseRef = useRef('');
			const lastPathRef = useRef(path);
			const dirty = editing && draft !== baseRef.current;
			const enter = useCallback(() => {
				baseRef.current = currentText ?? '';
				// restore an unsaved draft stashed when the file was switched away
				const stashed = readJson(LS.draft(path), null);
				setDraft(typeof stashed === 'string' && stashed ? stashed : baseRef.current);
				setEditing(true);
				onStatus(typeof stashed === 'string' && stashed ? t('panel.draftRestored') : t('panel.editModeHint'));
			}, [currentText, path, onStatus, t]);
			const exit = useCallback(() => {
				if (busy) return;
				if (draft !== baseRef.current && !window.confirm(t('panel.unsavedConfirm'))) return;
				removeDraft(path); // leaving on purpose: drop the stash
				setEditing(false);
				onStatus('');
			}, [busy, draft, path, onStatus, t]);
			const save = useCallback(async () => {
				if (!editing || busy) return;
				if (draft === baseRef.current) { onStatus(t('panel.noChanges')); return; }
				setBusy(true);
				try {
					const res = await fetch(`${ROUTE}/save`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ path, baseContent: baseRef.current, content: draft }),
					});
					const data = await res.json().catch(() => ({}));
					if (!res.ok) throw Object.assign(new Error(data.error || `${res.status}`), { status: res.status });
					baseRef.current = draft;
					removeDraft(path);
					onStatus(t('panel.saved'));
					onSaved(draft);
				} catch (e) {
					if (e.status === 409) {
						// the file changed on disk: rebase onto the fresh content but
						// KEEP the user's draft — saving again overwrites the disk copy
						const fresh = await fetchFile(path, 'text').catch(() => null);
						if (fresh !== null) baseRef.current = fresh;
						onStatus(t('panel.saveConflictRebased'));
					} else {
						onStatus(`${t('panel.saveFailed')}: ${e.message}`);
					}
				} finally {
					setBusy(false);
				}
			}, [editing, busy, draft, path, onSaved, onStatus, t]);
			// switching documents under the editor: stash the unsaved draft keyed
			// by the OLD path (localStorage quota permitting) instead of losing it
			useEffect(() => {
				const prev = lastPathRef.current;
				lastPathRef.current = path;
				if (prev !== path && editing && draft !== baseRef.current) {
					writeJson(LS.draft(prev), draft);
				}
				setEditing(false);
				setBusy(false);
			}, [path]);
			return { editing, draft, busy, dirty, enter, exit, save, setDraft };
		}

		function EditControls({ t, editing, dirty, busy, onEnter, onExit, onSave }) {
			return h(React.Fragment, null,
				h(Btn, { title: editing ? t('panel.exitEdit') : t('panel.editDocument'), pressed: editing, onClick: editing ? onExit : onEnter, disabled: busy }, Glyph.pencil(), editing ? t('panel.exitEdit') : t('panel.editDocument')),
				editing && h(Btn, { title: t('panel.save'), onClick: onSave, disabled: busy || !dirty }, t('panel.save')));
		}

		// ---------- settings overlay ----------
		/** Floating selection action bar: quote / copy / search-in-doc / translate,
		 * shown as soon as text is selected (icon buttons + instant tooltips). */
		function SelectionBar({ at, t, onQuote, onCopy, onSearch, onTranslate }) {
			const { hoverProps, hide: hideTip } = useTip('below'); // tooltip lives at document.body
			const grab = () => {
				try { return String(window.getSelection()?.toString() ?? ''); } catch { return ''; }
			};
			const btn = (key, glyph, label, run) => h('button', {
				type: 'button', 'aria-label': label, 'data-selbar-action': key,
				onMouseDown: (e) => { e.preventDefault(); }, // keep the selection alive
				onClick: () => { const text = grab(); hideTip(); if (text.trim()) run(text); },
				...hoverProps(label),
			}, glyph(13));
			return h('div', { className: 'dr-selbar', style: { left: at.x, top: at.y }, 'data-doc-reader-selbar': '1' },
				btn('quote', Glyph.quote, t('panel.quoteToChat'), onQuote),
				btn('copy', Glyph.copy, t('panel.menuCopy'), (text) => { try { navigator.clipboard.writeText(text).catch(() => { /* denied */ }); } catch { /* denied */ } onCopy(); }),
				btn('search', Glyph.search, t('panel.menuSearchInDoc'), onSearch),
				btn('translate', Glyph.translateG, t('panel.translate'), onTranslate));
		}

		/** Translation result dialog: plain translated text with copy. */
		function TranslateOverlay({ state, onClose, t, engineLabel, onRetry }) {
			const [copied, setCopied] = useState(false);
			useEffect(() => {
				const onKey = (e) => { if (e.key === 'Escape') onClose(); };
				window.addEventListener('keydown', onKey);
				return () => { window.removeEventListener('keydown', onKey); };
			}, [onClose]);
			return h('div', { style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.32)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }, onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
				h('div', { style: { width: 'min(520px, 86vw)', maxHeight: '72vh', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: '10px', padding: '16px', display: 'flex', flexDirection: 'column', gap: '12px', boxShadow: '0 12px 40px rgba(0,0,0,.3)' }, role: 'dialog', 'aria-label': t('panel.translateTitle') },
					h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', fontWeight: 600 } },
						`${t('panel.translateTitle')}${engineLabel ? ` · ${engineLabel}` : ''}`,
						h(Btn, { title: t('panel.close'), onClick: onClose }, t('panel.close'))),
					state.status === 'loading'
						? h('div', { className: 'dr-load' }, t('panel.translating'))
						: state.status === 'error'
							? h(React.Fragment, null,
								h('div', { className: 'dr-error', 'data-doc-reader-translate-error': '1' }, `${t('panel.translationFailed')}: ${state.error}`),
								h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
									h(Btn, { title: t('panel.retry'), 'data-doc-reader-translate-retry': '1', onClick: () => { onRetry?.(); } }, t('panel.retry'))))
							: h(React.Fragment, null,
							state.source ? h('div', { 'data-doc-reader-translate-source': '1', style: { flex: '0 0 auto', maxHeight: '34%', minHeight: 0, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '12px', lineHeight: 1.6, color: 'var(--dsw-alias-label-secondary)', fontFamily: 'var(--dsw-font-mono, monospace)', borderBottom: '.5px solid var(--dsw-alias-border-l2)', paddingBottom: '8px' } }, state.source) : null,
								h('pre', { 'data-doc-reader-translate': '1', style: { margin: 0, flex: 1, minHeight: 0, overflow: 'auto', whiteSpace: 'pre-wrap', fontSize: '13px', lineHeight: 1.7, color: 'var(--dsw-alias-label-primary)', fontFamily: 'inherit' } }, state.text),
								h('div', { style: { display: 'flex', justifyContent: 'flex-end' } },
									h(Btn, { title: t('panel.translateCopy'), 'data-doc-reader-translate-copy': '1', onClick: () => {
										try { navigator.clipboard.writeText(state.text ?? '').catch(() => { /* clipboard denied */ }); } catch { /* clipboard denied */ }
										setCopied(true);
										setTimeout(() => setCopied(false), 1600);
									} }, copied ? t('panel.copied') : t('panel.translateCopy'))))));
		}

		function SettingsOverlay({ settings, setSettings, onClose, t }) {
			const [draft, setDraft] = useState(settings);
			const [dshCatalog, setDshCatalog] = useState(null); // { providers: [{ name, models }] }
			useEffect(() => {
				if (draft.translateEngine !== 'dsh' || dshCatalog) return undefined;
				let alive = true;
				fetch(`${ROUTE}/translate-models`).then((r) => r.json()).then((c) => { if (alive && c && Array.isArray(c.providers)) setDshCatalog(c); }).catch(() => {});
				return () => { alive = false; };
			}, [draft.translateEngine, dshCatalog]);
			const commit = () => { setSettings(draft); writeJson(LS.settings, draft); onClose(); };
			const overlayStyle = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.32)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 };
			const cardStyle = { width: '340px', boxSizing: 'border-box', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: '10px', padding: '18px', display: 'flex', flexDirection: 'column', gap: '14px', boxShadow: '0 12px 40px rgba(0,0,0,.3)' };
			const rowStyle = { display: 'grid', gridTemplateColumns: '1fr auto', alignItems: 'center', gap: '10px', fontSize: '12.5px', color: 'var(--dsw-alias-label-primary)' };
			const numStyle = { width: '76px', height: '26px', boxSizing: 'border-box', padding: '0 8px', fontSize: '12px', font: '12px inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '6px', outline: 'none', textAlign: 'right' };
			const checkStyle = { width: '15px', height: '15px', margin: 0, accentColor: 'var(--dsw-alias-label-primary)' };
			return h('div', { style: overlayStyle, onClick: (e) => { if (e.target === e.currentTarget) onClose(); } },
				h('div', { style: cardStyle, role: 'dialog', 'aria-label': t('panel.settings') },
					h('div', { style: { margin: 0, fontSize: '14px', fontWeight: 600, display: 'flex', alignItems: 'baseline', gap: '8px' } },
						t('panel.settings'),
						h('span', { 'data-doc-reader-client-version': '1', style: { fontSize: '11px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)' } }, `v${CLIENT_VERSION}`)),
					h('div', { style: rowStyle }, h('span', null, t('panel.setFontSize')),
						h('input', { type: 'number', min: 10, max: 28, value: draft.fontSize, style: numStyle,
							onChange: (e) => setDraft({ ...draft, fontSize: clamp(Number(e.target.value) || 14, 10, 28) }) })),
					h('div', { style: rowStyle }, h('span', null, t('panel.setLineHeight')),
						h('input', { type: 'number', min: 1.2, max: 2.4, step: 0.1, value: draft.lineHeight, style: numStyle,
							onChange: (e) => setDraft({ ...draft, lineHeight: clamp(Number(e.target.value) || 1.7, 1.2, 2.4) }) })),
					h('div', { style: rowStyle }, h('span', null, t('panel.setRecentLimit')),
						h('input', { type: 'number', min: 5, max: 200, value: draft.recentLimit, style: numStyle,
							onChange: (e) => setDraft({ ...draft, recentLimit: clamp(Number(e.target.value) || 20, 5, 200) }) })),
					h('div', { style: rowStyle }, h('span', null, t('panel.setPdfTextLayer')),
						h('input', { type: 'checkbox', checked: draft.pdfTextLayer, style: checkStyle,
							onChange: (e) => setDraft({ ...draft, pdfTextLayer: e.target.checked }) })),
					h('div', { style: rowStyle }, h('span', null, t('panel.setDocxBreakPages')),
						h('input', { type: 'checkbox', checked: draft.docxBreakPages, style: checkStyle,
							onChange: (e) => setDraft({ ...draft, docxBreakPages: e.target.checked }) })),
							h('div', { style: rowStyle }, h('span', null, t('panel.setLanguage')),
								h('select', {
									value: draft.lang ?? 'auto',
									onChange: (e) => setDraft({ ...draft, lang: e.target.value }),
									style: { gridColumn: 2, width: '150px', height: '26px', boxSizing: 'border-box', fontSize: '12px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '6px', outline: 'none', textAlign: 'center' },
								},
									h('option', { value: 'auto' }, t('panel.langAuto')),
									h('option', { value: 'zh' }, '简体中文'),
									h('option', { value: 'zh-tw' }, '繁體中文'),
									h('option', { value: 'en' }, 'English'))),
							h('div', { style: rowStyle }, h('span', null, t('panel.translateTarget')),
								h('select', {
									value: draft.translateTarget ?? 'zh-Hans',
									onChange: (e) => setDraft({ ...draft, translateTarget: e.target.value }),
									style: { gridColumn: 2, width: '150px', height: '26px', boxSizing: 'border-box', fontSize: '12px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '6px', outline: 'none', textAlign: 'center' },
								},
									h('option', { value: 'zh-Hans' }, '简体中文'),
									h('option', { value: 'zh-Hant' }, '繁體中文'),
									h('option', { value: 'en' }, 'English'),
									h('option', { value: 'ja' }, '日本語'),
									h('option', { value: 'ko' }, '한국어'),
									h('option', { value: 'fr' }, 'Français'),
									h('option', { value: 'de' }, 'Deutsch'),
									h('option', { value: 'es' }, 'Español'))),
							h('div', { style: rowStyle }, h('span', null, t('panel.translateEngine')),
								h('select', {
									value: draft.translateEngine ?? 'bing',
									onChange: (e) => setDraft({ ...draft, translateEngine: e.target.value }),
									style: { gridColumn: 2, width: '150px', height: '26px', boxSizing: 'border-box', fontSize: '12px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '6px', outline: 'none', textAlign: 'center' },
								},
									h('option', { value: 'bing' }, t('panel.translateEngineBing')),
									h('option', { value: 'google' }, t('panel.translateEngineGoogle')),
									h('option', { value: 'dsh' }, t('panel.translateEngineDsh')))),
							draft.translateEngine === 'google' ? h('div', { style: { ...rowStyle, gridTemplateColumns: '1fr' } },
								h('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } },
									h('span', null, t('panel.translateGoogleEndpointLabel')),
									h('input', {
										type: 'text', value: draft.translateGoogleEndpoint ?? '', placeholder: t('panel.translateGoogleEndpointHint'),
										onChange: (e) => setDraft({ ...draft, translateGoogleEndpoint: e.target.value }),
										style: { width: '100%', height: '26px', boxSizing: 'border-box', fontSize: '12px', fontFamily: 'var(--dsw-font-mono, monospace)', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '6px', padding: '0 8px', outline: 'none' },
									}))) : null,
							draft.translateEngine === 'dsh' ? h('div', { style: rowStyle }, h('span', null, t('panel.translateModelLabel')),
								h('select', {
									value: `${draft.translateProvider || ''}::${draft.translateModel || ''}`,
									onChange: (e) => { const [provider, model] = String(e.target.value).split('::'); setDraft({ ...draft, translateProvider: provider, translateModel: model }); },
									style: { gridColumn: 2, width: '190px', height: '26px', boxSizing: 'border-box', fontSize: '12px', fontFamily: 'inherit', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: '6px', outline: 'none', textAlign: 'center' },
								},
								(dshCatalog?.providers ?? []).flatMap((p) => (p.models.length ? p.models : [null]).map((m) => h('option', { key: `${p.name}::${m ?? ''}`, value: `${p.name}::${m ?? ''}` }, m ? `${p.name} · ${m}` : p.name))))) : null,
					h('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px' } },
						h(Btn, { title: t('panel.close'), onClick: onClose }, t('panel.cancel')),
						h(Btn, { title: t('panel.save'), onClick: commit }, t('panel.save')))));
		}

		/** Controlled rename input: focuses and selects on mount; Enter commits, Escape cancels. */
		function RenameInput({ value, stem, onChange, onCommit, onCancel }) {
			const ref = useRef(null);
			useEffect(() => {
				const el = ref.current;
				if (!el) return;
				el.focus();
				el.select();
			}, []);
			return h('input', {
				ref,
				className: 'dr-rename-input', value, spellCheck: false,
				onChange: (e) => onChange(e.target.value),
				onBlur: onCommit,
				onKeyDown: (e) => {
					if (e.isComposing || e.keyCode === 229) return; // let IME confirm first
					if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
					if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
				},
			});
		}

		// ---------- main panel ----------
		/** Panel-local translation: honor the language setting when it is not
		 * "follow DSH" — registered slots (sidebar label etc.) keep following
		 * the global locale since they are snapshotted at registration. */
		function makePanelT(base, lang) {
			if (!lang || lang === 'auto' || !LOCALES[lang]) return base;
			const dict = LOCALES[lang];
			return (key) => dict[key] ?? base(key);
		}

		function makeReaderPanel(t) {
			return function ReaderPanel() {
				const [path, setPath] = useState(null);
				const [draft, setDraft] = useState('');
				const [showSide, setShowSide] = useState(true);
				const [showBrowse, setShowBrowse] = useState(false);
				const [settings, setSettings] = useState(getSettings);
				const localT = useMemo(() => makePanelT(t, settings.lang), [settings.lang]);
				const [showSettings, setShowSettings] = useState(false);
				const [sidebarModel, setSidebarModel] = useState(null);
				const [contentSideVisible, setContentSideVisible] = useState(true);
				const [sidebarVisible, setSidebarVisible] = useState(true);
				const [status, setStatus] = useState('');
				const [recentVersion, setRecentVersion] = useState(0);
				const [renaming, setRenaming] = useState(null); // { pending }
				const flashTimerRef = useRef(null);
				const flash = useCallback((message) => {
					setStatus(message);
					clearTimeout(flashTimerRef.current);
					if (message && message !== LOCALES.zh['panel.loading']) {
						flashTimerRef.current = setTimeout(() => setStatus(''), 3200);
					}
				}, []);
				useEffect(() => () => clearTimeout(flashTimerRef.current), []);

				const openSeqRef = useRef(0);
				const pathRef = useRef(null);
				pathRef.current = path;
				const lastOpenPathRef = useRef(null);
				const open = useCallback(async (p) => {
					if (!kindOf(p)) { flash(`${localT('panel.error')}: ${localT('panel.unsupported')}`); return; }
					// verify the file exists before touching the recent list so dead
					// entries (e.g. pre-rename leftovers) cannot resurrect themselves
					const seq = ++openSeqRef.current; // a newer open() must win over a slower older probe
					try {
						const probe = await fetch(FILE_URL(p), { method: 'HEAD' });
						if (seq !== openSeqRef.current) return;
						if (!probe.ok) {
							const detail = await probe.json().catch(() => ({}));
							flash(`${localT('panel.error')}: ${detail.error || localT('panel.notFound')}`);
							return;
						}
					} catch (e) {
						if (seq !== openSeqRef.current) return;
						flash(`${localT('panel.error')}: ${e.message}`);
						return;
					}
					pushRecent(p, getSettings().recentLimit);
					setRecentVersion((v) => v + 1);
					lastOpenPathRef.current = p;
					setPath(p);
					setDraft(p);
					setSidebarModel(null);
				}, [flash]);

				// consume handoff requests from other panels ("open in reader")
				const openRef = useRef(open);
				openRef.current = open;
				useEffect(() => {
					notifyReaderOpen = () => {
						const p = pendingReaderOpen;
						pendingReaderOpen = null;
						if (p) void openRef.current(p);
					};
					notifyReaderOpen(); // pick up a request that arrived before mount
					return () => { notifyReaderOpen = () => {}; };
				}, []);

				// global shortcut (Cmd/Ctrl+Shift+O): focus + select the path input
				useEffect(() => {
					const focusPath = () => {
						focusPathRequested = false;
						const input = document.querySelector('.dr-panel .dr-path');
						if (input) { try { input.focus(); input.select?.(); } catch { /* detached */ } }
					};
					window.addEventListener('doc-reader:focus-path', focusPath);
					if (focusPathRequested) setTimeout(focusPath, 60); // mounted after the shortcut fired
					return () => { window.removeEventListener('doc-reader:focus-path', focusPath); };
				}, []);

				// ---------- live integration with the host ----------
				// report the opened document (agent chat context + /doc recent list)
				useEffect(() => {
					if (typeof path !== 'string') return undefined;
					void fetch(ACTIVE_URL, {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ path }),
					}).catch(() => { /* host offline: reader keeps working */ });
					return undefined;
				}, [path]);

				// SSE: external disk changes auto-reload (or show a conflict bar while
				// editing); {type:'open'} broadcasts come from the /doc slash command
				const [reloadKey, setReloadKey] = useState(0);
				const [externalChange, setExternalChange] = useState(null); // { path }
				const editingRef = useRef(false);
				const onEditingChange = useCallback((flag) => { editingRef.current = !!flag; }, []);
				useEffect(() => {
					if (typeof EventSource !== 'function') return undefined; // tests/older hosts
					const es = new EventSource(EVENTS_URL(typeof path === 'string' ? path : null));
					es.onmessage = (event) => {
						let ev;
						try { ev = JSON.parse(event.data); } catch { return; }
						if (!ev || typeof ev.type !== 'string') return;
						if (ev.type === 'open' && typeof ev.path === 'string' && ev.path !== pathRef.current) {
							void openRef.current(ev.path);
						} else if (ev.type === 'change' && ev.path === pathRef.current) {
							if (editingRef.current) setExternalChange({ path: ev.path, at: Date.now() });
							else {
								setExternalChange(null);
								setReloadKey((k) => k + 1);
								flash(localT('panel.reloadedFromDisk'));
							}
						}
					};
					return () => { es.close(); };
				}, [path, localT, flash]);
				const reloadFromDisk = () => {
					if (typeof path === 'string') removeDraft(path); // reload means: discard my draft
					setExternalChange(null);
					setReloadKey((k) => k + 1);
				};

				// ---------- selection → "quote to chat" floating button ----------
				// Mirrors the transcript quote action: pick text in the rendered
				// document, get one button, click to drop a blockquote into the
				// conversation composer (clipboard fallback when no composer).
				const contentRef = useRef(null);
				const [quoteAt, setQuoteAt] = useState(null); // { x, y }
				useEffect(() => {
					if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
					let timer = null;
					const update = () => {
						if (timer) clearTimeout(timer);
						timer = setTimeout(() => {
							timer = null;
							const content = contentRef.current;
							if (!content || editingRef.current) { setQuoteAt(null); return; }
							let sel = null;
							try { sel = window.getSelection(); } catch { sel = null; }
							const text = sel ? String(sel.toString() ?? '') : '';
							if (!sel || sel.isCollapsed || !text.trim() || text.trim().length > 4000) { setQuoteAt(null); return; }
							const node = sel.anchorNode;
							const el = node ? (node.nodeType === 1 ? node : node.parentNode) : null;
							if (!el || !content.contains(el)) { setQuoteAt(null); return; }
							// Range.getBoundingClientRect is missing on some hosts (jsdom);
							// fall back to the anchor element's box, then to 0,0
							let rect = null;
							try {
								const range = sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
								if (range && typeof range.getBoundingClientRect === 'function') rect = range.getBoundingClientRect();
								else if (el && typeof el.getBoundingClientRect === 'function') rect = el.getBoundingClientRect();
							} catch { rect = null; }
							if (!rect) { setQuoteAt(null); return; }
							setQuoteAt({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top) });
						}, 120);
					};
					document.addEventListener('selectionchange', update);
					return () => { document.removeEventListener('selectionchange', update); if (timer) clearTimeout(timer); };
				}, []);
				const quoteNow = async () => {
					let sel = null;
					try { sel = window.getSelection(); } catch { sel = null; }
					const text = sel ? String(sel.toString() ?? '') : '';
					setQuoteAt(null);
					if (!text.trim() || typeof path !== 'string') return;
					const outcome = await quoteSelectionToChat(displayName, text);
					try { sel?.removeAllRanges?.(); } catch { /* fine */ }
					flash(outcome === 'chat' ? localT('panel.quotedToChat') : outcome === 'copied' ? localT('panel.quoteCopied') : localT('panel.quoteFailed'));
				};

				// ---------- content context menu ----------
				const [ctxMenu, setCtxMenu] = useState(null); // { x, y, selection }
				const openContextMenu = (e) => {
					if (editingRef.current) return; // keep the native menu while editing
					let sel = null;
					try { sel = window.getSelection(); } catch { sel = null; }
					const selection = (sel ? String(sel.toString() ?? '') : '').trim().slice(0, 2000);
					e.preventDefault();
					const x = Math.min(e.clientX, (typeof window !== 'undefined' && window.innerWidth ? window.innerWidth - 190 : e.clientX));
					setCtxMenu({ x, y: e.clientY, selection });
				};
				useEffect(() => {
					if (!ctxMenu) return undefined;
					const onDown = (e) => { if (!e.target?.closest?.('.dr-ctxmenu')) setCtxMenu(null); };
					const close = () => setCtxMenu(null);
					window.addEventListener('mousedown', onDown);
					window.addEventListener('resize', close);
					return () => { window.removeEventListener('mousedown', onDown); window.removeEventListener('resize', close); };
				}, [ctxMenu]);
				// selection translation via the optional Host translator bridge
				const [translateState, setTranslateState] = useState(null); // { status, text?, error? }
				const lastTranslateTextRef = useRef('');
				const runTranslate = (text) => {
					lastTranslateTextRef.current = text;
					setTranslateState({ status: 'loading' });
					const s = getSettings();
					fetch(TRANSLATE_URL, {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({
							text, targetLanguage: s.translateTarget || 'zh-Hans',
							...(s.translateEngine === 'dsh' ? { engine: 'dsh', provider: s.translateProvider || undefined, model: s.translateModel || undefined } : {}),
						...(s.translateEngine === 'google' ? { engine: 'google', endpoint: s.translateGoogleEndpoint || undefined } : {}),
						}),
					})
						.then(async (res) => { const d = await res.json().catch(() => ({})); if (!res.ok) throw new Error(d.error || `${res.status}`); return d; })
						.then((d) => setTranslateState({ status: 'ready', text: String(d.text ?? ''), source: text, engineLabel: d.engine === 'dsh' ? (getSettings().translateModel || 'DSH') : d.engine === 'google' ? 'Google' : undefined }))
						.catch((e) => setTranslateState({ status: 'error', error: e.message }));
				};
				const searchInDoc = (term) => {
					const input = contentRef.current?.querySelector('.dr-viewbar input[type="search"], .dr-viewbar input[type="text"]');
					if (!input) { flash(localT('panel.searchUnavailable')); return; }
					try {
						const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
						setter.call(input, term);
						input.dispatchEvent(new window.Event('input', { bubbles: true }));
						input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
						input.focus?.();
					} catch { flash(localT('panel.searchUnavailable')); }
				};

				const renameFile = useCallback(async (from, name) => {
					if (!name || !name.trim()) return;
					setRenaming({ pending: true });
					try {
						const res = await fetch(RENAME_URL, {
							method: 'POST',
							headers: { 'content-type': 'application/json' },
							body: JSON.stringify({ path: from, name: name.trim() }),
						});
						const data = await res.json().catch(() => ({}));
						if (!res.ok) throw new Error(data.error || `${res.status}`);
						// migrate recent + position to the new path
						const recent = readJson(LS.recent, []).map((e) => (e.path === from ? { ...e, path: data.path, kind: kindOf(data.path) } : e));
						writeJson(LS.recent, recent);
						try {
							const saved = localStorage.getItem(LS.pos(from));
							if (saved) { localStorage.setItem(LS.pos(data.path), saved); localStorage.removeItem(LS.pos(from)); }
							const draft = localStorage.getItem(LS.draft(from));
							if (draft) { localStorage.setItem(LS.draft(data.path), draft); localStorage.removeItem(LS.draft(from)); }
						} catch { /* storage disabled — rename itself already succeeded */ }
						setRecentVersion((v) => v + 1);
						flash(`${localT('panel.renameDone')}: ${data.path.slice(data.path.lastIndexOf('/') + 1)}`);
						if (pathRef.current === from && lastOpenPathRef.current === from) open(data.path); // never override a newer explicit open
					} catch (e) {
						flash(`${localT('panel.renameFailed')}: ${e.message}`);
					} finally {
						setRenaming(null);
					}
				}, [flash, open]);

				const kind = typeof path === 'string' ? kindOf(path) : null;
				const displayName = typeof path === 'string' ? path.slice(path.lastIndexOf('/') + 1) : '';
				const stem = displayName.includes('.') ? displayName.slice(0, displayName.lastIndexOf('.')) : displayName;

				// title rename UI
				const [renameDraft, setRenameDraft] = useState('');
				const [renameActive, setRenameActive] = useState(false);
				const renameCancelledRef = useRef(false);
				// toolbar hover explanations are dark side-anchored bubbles (the
				// platform's own sidebar-toggle pattern), vertically centered on
				// the hovered button. The right-side icons share ONE fixed hint
				// slot: every bubble's right border sits EXACTLY on the path
				// input's right border (product requirement — confirmed), so the
				// position never depends on which icon is hovered. The anchor
				// reads the input ref, backed by a live DOM re-query so a
				// mid-remount hover can never degrade to button-hugging. The
				// left-most rename button anchors to its RIGHT, 8px past it.
				const pathInputRef = useRef(null);
				const { hoverProps: sideHover } = useTip('left');
				const { hoverProps: renameHover } = useTip('right');
				const iconHint = (text) => sideHover(text, (el) => pathInputRef.current ?? el?.closest?.('.dr-toolbar')?.querySelector('.dr-path'));

				const startRename = () => {
					if (typeof path !== 'string' || renaming?.pending) return;
					renameCancelledRef.current = false; // stale cancel flag would swallow the next commit
					setRenameDraft(stem);
					setRenameActive(true);
					flash(localT('panel.renamePrompt'));
				};

				const viewProps = {
					path, settings, t: localT, onStatus: flash, onSidebar: setSidebarModel, onOpen: open,
					sidebar: sidebarModel
						? (contentSideVisible
							? h(ContentSidebar, { model: sidebarModel, t, onCollapse: () => setContentSideVisible(false) })
							: h('button', { className: 'dr-toc-expand', title: localT('panel.outline'), 'aria-label': localT('panel.outline'), onClick: () => setContentSideVisible(true) }, '›'))
						: null,
				};
				return h('div', { className: 'dr-panel', 'data-doc-reader-version': CLIENT_VERSION },
					h('style', null, CSS),
					h('div', { className: 'dr-toolbar' },
						h('span', { className: 'dr-logo' }, Glyph.logo(16), localT('panel.title')),
						typeof path === 'string' && h('span', { className: 'dr-rename' },
							renameActive
								? h(RenameInput, {
									value: renameDraft, stem,
									onChange: (v) => setRenameDraft(v),
									onCommit: () => {
										setRenameActive(false);
										if (renameCancelledRef.current) { renameCancelledRef.current = false; return; }
										if (renameDraft.trim() && renameDraft.trim() !== stem) void renameFile(path, renameDraft);
									},
									onCancel: () => { renameCancelledRef.current = true; setRenameActive(false); },
								})
									: h('button', {
										className: 'dr-rename-btn', 'aria-label': localT('panel.renameFile'),
										onClick: startRename,
										onDoubleClick: startRename,
										...renameHover(localT('panel.renameFile')),
									}, h('span', { className: 'dr-rename-name' }, displayName), Glyph.pencil())),
						h('input', {
							className: 'dr-path', ref: pathInputRef, value: draft, placeholder: localT('panel.placeholder'), spellCheck: false,
							onChange: (e) => setDraft(e.target.value),
							onKeyDown: (e) => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) open(draft.trim()); },
						}),
						h(Btn, {
							title: localT('panel.copyPath'), icon: true, instantTip: true,
							'data-doc-reader-copy-path': '1', disabled: typeof path !== 'string',
							onClick: () => {
								if (typeof path !== 'string') return;
								// copy the OPEN file's path, not the (possibly edited) input draft
								try { navigator.clipboard.writeText(path).catch(() => { /* clipboard denied */ }); flash(localT('panel.copied')); } catch { /* clipboard denied */ }
							},
							...iconHint(localT('panel.copyPath')),
						}, Glyph.copy(14)),
						h(Btn, { title: localT('panel.toggleSide'), icon: true, instantTip: true, onClick: () => setShowSide((v) => !v), pressed: showSide, ...iconHint(localT('panel.toggleSide')) }, Glyph.sidebar(14)),
						h(Btn, { title: localT('panel.settings'), icon: true, instantTip: true, onClick: () => setShowSettings(true), ...iconHint(localT('panel.settings')) }, Glyph.sliders(14))),
					externalChange && h('div', { className: 'dr-external', role: 'alert' },
						h('span', { className: 'dr-external-msg' }, localT('panel.externalChanged')),
						h('button', { className: 'dr-btn', onClick: reloadFromDisk }, localT('panel.reloadNow')),
						h('button', { className: 'dr-btn', onClick: () => setExternalChange(null) }, localT('panel.keepEditing'))),
					h('div', { className: 'dr-body' },
						h('div', { className: showSide ? 'dr-side' : 'dr-side-hidden' },
							h('div', { className: 'dr-side-head' },
								h('span', { className: 'dr-side-title' }, localT('panel.recent')),
								h(Btn, { title: localT('panel.browse'), onClick: () => setShowBrowse(true) }, Glyph.folder(13), ' ', localT('panel.browse'))),
							h(RecentList, { onOpen: open, onFlash: flash, settings, version: recentVersion, t })),
					h('div', { className: 'dr-content', ref: contentRef, onContextMenu: openContextMenu },
						path === null
							? h('div', { className: 'dr-empty' }, Glyph.logo(44), h('span', null, localT('panel.dropHint')))
							: h(View, { ...viewProps, onEditingChange, key: `${path}#${reloadKey}` }))),
					quoteAt && typeof path === 'string' && h(SelectionBar, {
						at: quoteAt, t: localT,
						onQuote: () => { void quoteNow(); },
						onCopy: () => { flash(localT('panel.copied')); },
						onSearch: (text) => { searchInDoc(text); },
						onTranslate: (text) => { runTranslate(text); },
					}),
					ctxMenu && h('div', { className: 'dr-ctxmenu', style: { left: ctxMenu.x, top: ctxMenu.y }, 'data-doc-reader-menu': '1' },
						ctxMenu.selection ? h('button', {
							onClick: () => { const s = ctxMenu.selection; setCtxMenu(null); void quoteSelectionToChat(displayName, s).then((r) => { flash(r === 'chat' ? localT('panel.quotedToChat') : r === 'copied' ? localT('panel.quoteCopied') : localT('panel.quoteFailed')); }); },
						}, localT('panel.quoteToChat')) : null,
						ctxMenu.selection ? h('button', {
							onClick: () => { const s = ctxMenu.selection; setCtxMenu(null); try { navigator.clipboard.writeText(s).catch(() => { /* clipboard denied */ }); flash(localT('panel.copied')); } catch { /* clipboard denied */ } },
						}, localT('panel.menuCopy')) : null,
						ctxMenu.selection ? h('button', {
							onClick: () => { const s = ctxMenu.selection; setCtxMenu(null); searchInDoc(s); },
						}, localT('panel.menuSearchInDoc')) : null,
						ctxMenu.selection ? h('button', {
							onClick: () => { const s = ctxMenu.selection; setCtxMenu(null); runTranslate(s); },
						}, localT('panel.translate')) : null,
						typeof path === 'string' ? h('button', {
							onClick: () => { setCtxMenu(null); void fetch(REVEAL_URL(path)).catch(() => {}); },
						}, localT('panel.revealInFinder')) : null),
					typeof path === 'string' && h('div', { className: 'dr-status', 'aria-live': 'polite' }, status),
					translateState && h(TranslateOverlay, { state: translateState, onClose: () => setTranslateState(null), t: localT, engineLabel: translateState.engineLabel, onRetry: () => { if (lastTranslateTextRef.current) runTranslate(lastTranslateTextRef.current); } }),
				showSettings && h(SettingsOverlay, { settings, setSettings, onClose: () => setShowSettings(false), t: localT }),
					showBrowse && h(BrowseOverlay, {
						t, version: recentVersion,
						onOpen: (p) => { setShowBrowse(false); void open(p); },
						onClose: () => setShowBrowse(false),
					}));
			};
		}

		/** Office deck/spreadsheet: Host converts to PDF via the official
		 * libreoffice-kit, then rendering reuses the battle-tested PdfView. */
		function OfficeView(props) {
			const { path, t } = props;
			const [state, setState] = useState({ status: 'loading' });
			useEffect(() => {
				let alive = true;
				const controller = new AbortController();
				setState({ status: 'loading' });
				fetch(`${ROUTE}/convert?path=${encodeURIComponent(path)}`, { signal: controller.signal })
					.then(async (res) => {
						const data = await res.json().catch(() => ({}));
						if (!res.ok) throw new Error(data.error || `${res.status}`);
						return data;
					})
					.then((data) => { if (alive && typeof data.pdfPath === 'string') setState({ status: 'ready', pdfPath: data.pdfPath }); })
					.catch((e) => { if (alive && e?.name !== 'AbortError') setState({ status: 'error', message: e.message }); });
				return () => { alive = false; controller.abort(); };
			}, [path]);
			if (state.status === 'error') return h('div', { className: 'dr-error' }, `${t('panel.error')}: ${state.message}`);
			if (state.status !== 'ready') return h('div', { className: 'dr-load' }, t('panel.converting'));
			return h(PdfView, { ...props, path: state.pdfPath });
		}

		function View(props) {
			const kind = kindOf(props.path);
			if (kind === 'office') return h(OfficeView, props);
			if (kind === 'markdown') return h(MarkdownView, props);
			if (kind === 'text') return h(TextView, props);
			if (kind === 'image') return h(ImageView, props);
			if (kind === 'pdf') return h(PdfView, props);
			if (kind === 'docx') return h(DocxView, props);
		if (kind === 'epub') return h(EpubView, props);
		if (kind === 'html') return h(HtmlView, props);
			return h('div', { className: 'dr-error' }, props.t('panel.unsupported'));
		}

		function PanelIcon({ size }) {
			return Glyph.logo(size ?? 18);
		}

		// ---------- embedded dictionaries ----------
		const STRINGS = {
			en: {
				meta: { title: 'Doc reader', description: 'Read local PDF, DOCX, Markdown, text, and image files in a dedicated panel.' },
				panel: {
					title: 'Reader', toggleSide: 'Toggle recent-files sidebar', placeholder: 'Type an absolute local file path and press Enter…',
					open: 'Open', browse: 'Open file', recent: 'Recent files', recentEmpty: 'No files opened yet',
					clearRecent: 'Clear recent files', removeRecent: 'Remove from recent', revealInFinder: 'Reveal in file manager',
					error: 'Cannot open', unsupported: 'Unsupported file type', notFound: 'File not found',
					loading: 'Loading…', loadingPdf: 'Loading PDF…', emptyDir: 'No readable files in this folder',
					outline: 'Outline', pages: 'Pages', page: 'Page',
					search: 'Search', searchPrev: 'Previous match', searchNext: 'Next match', searching: 'Searching…', noMatches: 'No matches',
					searchTruncated: 'Too many matches — highlighting the first 5000 only',
					retryHint: 'close and reopen the file to retry',
					searchPrevShort: 'Prev', fontSmaller: 'Smaller font', fontBigger: 'Larger font', fontReset: 'Reset font size',
					prevPage: 'Previous page', nextPage: 'Next page',
					zoomIn: 'Zoom in', zoomOut: 'Zoom out', zoomReset: 'Reset zoom (100%)',
					rotateLeft: 'Rotate left 90°', rotateRight: 'Rotate right 90°', fitWindow: 'Fit window', fitWidth: 'Fit width',
					pdfRenderFailed: 'Page failed to render', pdfSearchDisabled: 'PDF text search is off (Settings)',
					docxTooLarge: 'DOCX too large to render (>100MB)', docxRendered: 'DOCX rendered', dropHint: 'Paste a supported file path above to open it',
					renameFile: 'Rename file', renamePrompt: 'Type a new name, then press Enter', renameDone: 'Renamed', renameFailed: 'Rename failed',
					editDocument: 'Edit', exitEdit: 'Exit edit', saved: 'Saved', saveFailed: 'Save failed', setLanguage: 'Language', langAuto: 'Follow DSH', noChanges: 'No changes to save', unsavedConfirm: 'Discard unsaved changes?', draftRestored: 'Unsaved draft restored', saveConflictRebased: 'File changed on disk — rebased. Save again to overwrite, or exit to discard.', resizeSidebar: 'Drag to resize sidebar', openInReader: 'Open in reader', commandSearch: 'Search', commandRecent: 'Recent docs', listTruncated: 'List truncated at 2000 entries', mdPlainMode: 'Large document — plain text mode', editModeHint: 'Editing — Ctrl/Cmd+S to save', collapseSidebar: 'Collapse sidebar', settings: 'Reader settings', setFontSize: 'Base font size (10–28)', setLineHeight: 'Line height (1.2–2.4)',
					setRecentLimit: 'Recent files limit (5–200)', setPdfTextLayer: 'PDF text-layer search',
					setDocxBreakPages: 'DOCX page breaks', save: 'Save', cancel: 'Cancel', close: 'Close',
					reloadedFromDisk: 'Reloaded — file changed on disk', externalChanged: 'This file changed on disk while you are editing it', reloadNow: 'Reload from disk', keepEditing: 'Keep editing',
					rowConfig: 'Reader settings', cfgCtxInject: 'Inject active document outline into chat context', cfgCtxInjectHint: 'Lets the assistant see which document you are reading', cfgAutoReload: 'Auto-reload on external changes', cfgAutoReloadHint: 'Reload the reader when the file changes on disk', cfgTool: 'doc_reader agent tool', cfgToolHint: 'Let the assistant read local documents in chat', cfgCommand: '/doc slash command', cfgCommandHint: 'Open recent documents from the chat box', cfgOutlineCount: 'Outline entries injected', translate: 'Translate', translating: 'Translating…', translationFailed: 'Translation failed', translateTitle: 'Translation', translateTarget: 'Translate into', retry: 'Retry', copied: 'Copied ✓', translateEngine: 'Translation engine', translateEngineBing: 'Bing (free, anonymous)', translateEngineGoogle: 'Google (free, anonymous)', translateEngineDsh: 'DSH model (configured provider)', translateModelLabel: 'Model', translateGoogleEndpointLabel: 'Google-compatible endpoint', translateGoogleEndpointHint: 'default: translate.googleapis.com — any reverse proxy works', translateCopy: 'Copy',
					quoteToChat: 'Quote to chat', quotedToChat: 'Quoted into the chat input', quoteCopied: 'Quote copied — paste it into the chat', quoteFailed: 'Could not quote — copy manually', menuCopy: 'Copy', menuSearchInDoc: 'Search in document', copied: 'Copied', copyPath: 'Copy file path', searchUnavailable: 'Search is not available in this view', atDocs: 'Recent documents', searchJumped: 'Searched in chapter', shortcutOpen: 'Open the doc reader and focus its path box', converting: 'Converting document…',
				},
			},
			zh: {
				meta: { title: '文档阅读器', description: '在独立面板中阅读本地 PDF、DOCX、Markdown、文本与图片文件。' },
				panel: {
					title: '阅读器', toggleSide: '展开/收起最近文件侧栏', placeholder: '输入本地文件绝对路径后回车…',
					open: '打开', browse: '打开文件', recent: '最近文件', recentEmpty: '还没有打开过文件', openInReader: '在阅读器打开', commandSearch: '搜索', commandRecent: '最近文档',
					clearRecent: '清空最近文件', removeRecent: '从最近文件删除', revealInFinder: '在文件管理器中显示',
					error: '无法打开', unsupported: '不支持的文件类型', notFound: '文件不存在',
					loading: '加载中…', loadingPdf: '正在加载 PDF…', emptyDir: '此目录下没有可读文件',
					outline: '大纲', pages: '页面', page: '页',
					search: '搜索', searchPrev: '上一个', searchNext: '下一个', searching: '搜索中…', noMatches: '未找到匹配项',
					searchTruncated: '匹配过多，仅高亮前 5000 处',
					retryHint: '关闭后重新打开该文件即可重试',
					searchPrevShort: '上一个', fontSmaller: '缩小字号', fontBigger: '放大字号', fontReset: '重置字号',
					prevPage: '上一页', nextPage: '下一页',
					zoomIn: '放大', zoomOut: '缩小', zoomReset: '恢复 100%',
					rotateLeft: '左转 90°', rotateRight: '右转 90°', fitWindow: '适应窗口', fitWidth: '适应宽度',
					pdfRenderFailed: '页面渲染失败', pdfSearchDisabled: 'PDF 文本搜索已关闭(见设置)',
					docxTooLarge: 'DOCX 过大(>100MB)，无法渲染', docxRendered: 'DOCX 渲染完成', dropHint: '把支持的文件路径粘贴到上方打开',
					renameFile: '重命名文件', renamePrompt: '输入新名称后回车确认', renameDone: '已重命名', renameFailed: '重命名失败',
					editDocument: '编辑', exitEdit: '退出编辑', saved: '已保存', saveFailed: '保存失败', setLanguage: '语言', langAuto: '跟随 DSH', noChanges: '没有可保存的更改', unsavedConfirm: '放弃未保存的更改?', draftRestored: '已恢复上次未保存的草稿', saveConflictRebased: '文件在磁盘上已变化，已用磁盘版本作为基线；再次保存将覆盖，退出编辑则放弃', resizeSidebar: '拖动调整侧栏宽度', openInReader: '用阅读器打开', listTruncated: '条目过多，仅显示前 2000 项', mdPlainMode: '大文档——纯文本模式', editModeHint: '编辑中 — Ctrl/Cmd+S 保存', collapseSidebar: '收起侧栏', settings: '阅读器设置', setFontSize: '基准字号(10–28)', setLineHeight: '行高(1.2–2.4)',
					setRecentLimit: '最近文件上限(5–200)', setPdfTextLayer: 'PDF 文本层搜索',
					setDocxBreakPages: 'DOCX 分页渲染', save: '保存', cancel: '取消', close: '关闭',
					reloadedFromDisk: '文件在磁盘上已变更，已自动重载', externalChanged: '编辑中的文件已在磁盘上被修改', reloadNow: '重载磁盘版本', keepEditing: '继续编辑',
					rowConfig: '阅读器设置', cfgCtxInject: '把当前文档大纲注入对话上下文', cfgCtxInjectHint: '让助手知道你正在阅读的文档', cfgAutoReload: '外部修改自动刷新', cfgAutoReloadHint: '文件在磁盘上变化时自动重载阅读器', cfgTool: 'doc_reader 对话工具', cfgToolHint: '让助手在对话中读取本地文档', cfgCommand: '/doc 斜杠命令', cfgCommandHint: '在输入框快速打开最近文档', cfgOutlineCount: '注入的大纲条数', translate: '翻译', translating: '翻译中…', translationFailed: '翻译失败', translateTitle: '翻译结果', translateTarget: '翻译目标语言', retry: '重试', copied: '已复制 ✓', translateEngine: '翻译引擎', translateEngineBing: '必应(免费匿名)', translateEngineGoogle: 'Google(免费匿名)', translateEngineDsh: 'DSH 模型(已配置的服务商)', translateModelLabel: '模型', translateGoogleEndpointLabel: 'Google 兼容端点', translateGoogleEndpointHint: '默认 translate.googleapis.com,可填自建反代', translateCopy: '复制',
					quoteToChat: '引用到对话', quotedToChat: '已引用到对话输入框', quoteCopied: '引用已复制，粘贴到对话输入框即可', quoteFailed: '引用失败，请手动复制', menuCopy: '复制', menuSearchInDoc: '在文档中搜索', copied: '已复制', copyPath: '复制文件路径', searchUnavailable: '当前视图不支持搜索', atDocs: '最近文档', searchJumped: '已跳转搜索', shortcutOpen: '打开文档阅读器并聚焦路径输入', converting: '正在转换文档…',
				},
			},
			'zh-tw': {
				meta: { title: '文件閱讀器', description: '在獨立面板中閱讀本地 PDF、DOCX、Markdown、文字與圖片文件。' },
				panel: {
					title: '閱讀器', toggleSide: '展開/收合最近文件側欄', placeholder: '輸入本地文件絕對路徑後按 Enter…',
					open: '開啟', browse: '開啟文件', recent: '最近文件', recentEmpty: '尚未開啟過文件', openInReader: '在閱讀器開啟', commandSearch: '搜尋', commandRecent: '最近文件',
					clearRecent: '清空最近文件', removeRecent: '從最近文件刪除', revealInFinder: '在檔案管理器中顯示',
					error: '無法開啟', unsupported: '不支援的文件類型', notFound: '文件不存在',
					loading: '載入中…', loadingPdf: '正在載入 PDF…', emptyDir: '此目錄下沒有可讀文件',
					outline: '大綱', pages: '頁面', page: '頁',
					search: '搜尋', searchPrev: '上一個', searchNext: '下一個', searching: '搜尋中…', noMatches: '未找到符合項',
					searchTruncated: '匹配過多，僅高亮前 5000 處',
					retryHint: '關閉後重新開啟該檔案即可重試',
					searchPrevShort: '上一個', fontSmaller: '縮小字號', fontBigger: '放大字號', fontReset: '重設字號',
					prevPage: '上一頁', nextPage: '下一頁',
					zoomIn: '放大', zoomOut: '縮小', zoomReset: '恢復 100%',
					rotateLeft: '左轉 90°', rotateRight: '右轉 90°', fitWindow: '適應視窗', fitWidth: '適應寬度',
					pdfRenderFailed: '頁面渲染失敗', pdfSearchDisabled: 'PDF 文字搜尋已關閉(見設定)',
					docxTooLarge: 'DOCX 過大(>100MB)，無法渲染', docxRendered: 'DOCX 渲染完成', dropHint: '把支援的文件路徑貼到上方開啟',
					renameFile: '重新命名文件', renamePrompt: '輸入新名稱後按 Enter 確認', renameDone: '已重新命名', renameFailed: '重新命名失敗',
					editDocument: '編輯', exitEdit: '退出編輯', saved: '已儲存', saveFailed: '儲存失敗', setLanguage: '語言', langAuto: '跟隨 DSH', noChanges: '沒有可儲存的變更', unsavedConfirm: '放棄未儲存的變更?', draftRestored: '已恢復上次未儲存的草稿', saveConflictRebased: '檔案在磁碟上已變化，已用磁碟版本作為基線；再次儲存將覆蓋，退出編輯則放棄', resizeSidebar: '拖動調整側欄寬度', openInReader: '用閱讀器開啟', listTruncated: '條目過多，僅顯示前 2000 項', mdPlainMode: '大文件——純文字模式', editModeHint: '編輯中 — Ctrl/Cmd+S 儲存', collapseSidebar: '收起側欄', settings: '閱讀器設定', setFontSize: '基準字號(10–28)', setLineHeight: '行高(1.2–2.4)',
					setRecentLimit: '最近文件上限(5–200)', setPdfTextLayer: 'PDF 文字層搜尋',
					setDocxBreakPages: 'DOCX 分頁渲染', save: '儲存', cancel: '取消', close: '關閉',
					reloadedFromDisk: '檔案在磁碟上已變更，已自動重新載入', externalChanged: '編輯中的檔案已在磁碟上被修改', reloadNow: '重新載入磁碟版本', keepEditing: '繼續編輯',
					rowConfig: '閱讀器設定', cfgCtxInject: '把目前文件大綱注入對話上下文', cfgCtxInjectHint: '讓助手知道你正在閱讀的文件', cfgAutoReload: '外部修改自動重新載入', cfgAutoReloadHint: '檔案在磁碟上變化時自動重新載入閱讀器', cfgTool: 'doc_reader 對話工具', cfgToolHint: '讓助手在對話中讀取本機文件', cfgCommand: '/doc 斜線命令', cfgCommandHint: '在輸入框快速開啟最近文件', cfgOutlineCount: '注入的大綱條數', translate: '翻譯', translating: '翻譯中…', translationFailed: '翻譯失敗', translateTitle: '翻譯結果', translateTarget: '翻譯目標語言', retry: '重試', copied: '已複製 ✓', translateEngine: '翻譯引擎', translateEngineBing: '必應(免費匿名)', translateEngineGoogle: 'Google(免費匿名)', translateEngineDsh: 'DSH 模型(已設定的服務商)', translateModelLabel: '模型', translateGoogleEndpointLabel: 'Google 相容端點', translateGoogleEndpointHint: '預設 translate.googleapis.com,可填自建反向代理', translateCopy: '複製',
					quoteToChat: '引用到對話', quotedToChat: '已引用到對話輸入框', quoteCopied: '引用已複製，貼到對話輸入框即可', quoteFailed: '引用失敗，請手動複製', menuCopy: '複製', menuSearchInDoc: '在文件中搜尋', copied: '已複製', copyPath: '複製文件路徑', searchUnavailable: '目前檢視不支援搜尋', atDocs: '最近文件', searchJumped: '已跳轉搜尋', shortcutOpen: '開啟文件閱讀器並聚焦路徑輸入', converting: '正在轉換文件…',
				},
			},
		};
		// locale dictionaries are FLAT dot-path maps (official client plugins use
		// `{"browser.home": "…"}`, not nested objects) — flatten ours at build time.
		function flattenDict(prefix, obj, out) {
			for (const [key, value] of Object.entries(obj)) {
				if (value && typeof value === 'object') flattenDict(`${prefix}${key}.`, value, out);
				else out[`${prefix}${key}`] = String(value);
			}
			return out;
		}
		const LOCALES = Object.fromEntries(['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh', 'zh-tw'].map(
			(id) => [id, flattenDict('', STRINGS[id] ?? STRINGS.en, {})],
		));

		// ---------- cross-slot handoff: "open in reader" from other panels ----------
		// The reader panel owns its open state; handoff buttons elsewhere (document
		// preview, unpreviewable files) park the requested path here. The panel
		// consumes it on mount or via the listener when already mounted.
		let pendingReaderOpen = null;
		let notifyReaderOpen = () => {};
		const requestReaderOpen = (path) => {
			pendingReaderOpen = path;
			notifyReaderOpen();
		};
		function makeReaderHandoff(t, activatePanel) {
			return function ReaderHandoffAction(props) {
				const path = props.absolutePath;
				if (typeof path !== 'string' || !kindOf(path)) return null;
				return h('button', {
					type: 'button',
					title: t('panel.openInReader'),
					'aria-label': t('panel.openInReader'),
					onClick: () => { activatePanel(); requestReaderOpen(path); },
					style: {
						width: '28px', height: '28px', flex: 'none', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
						background: 'transparent', border: 'none', borderRadius: 'var(--dsw-radius-sm)',
						color: 'var(--dsw-alias-label-secondary)', cursor: 'pointer', padding: 0,
					},
					onMouseEnter: (e) => { e.currentTarget.style.background = 'var(--dsw-alias-interactive-bg-hover)'; e.currentTarget.style.color = 'var(--dsw-alias-label-primary)'; },
					onMouseLeave: (e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--dsw-alias-label-secondary)'; },
				}, Glyph.logo(15));
			};
		}

		// ---------- global shortcut focus request ----------
		// The Cmd/Ctrl+Shift+O shortcut activates the panel and asks it to focus
		// the path input. A flag survives the case where the panel mounts only
		// after selectPanel (the event would fire before any listener exists).
		let focusPathRequested = false;

		// ---------- tool.call.toolview: doc_reader tool result card ----------
		// Renders inside the chat flow, OUTSIDE the reader panel: the panel
		// stylesheet does not reach it, so every style is inline and the card
		// reads only theme tokens (weread-plugin pattern, defensively propped).
		function makeToolCard(t, activatePanel) {
			const S = {
				wrapper: { border: '.5px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '8px 10px', fontSize: 12, maxWidth: 460, margin: '4px 0', background: 'var(--dsw-alias-bg-layer-2)' },
				head: { display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600, minWidth: 0 },
				file: { fontWeight: 400, color: 'var(--dsw-alias-label-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1, minWidth: 0 },
				pre: { margin: '6px 0 0', whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto', color: 'var(--dsw-alias-label-secondary)', fontSize: 11, lineHeight: 1.5 },
				btn: { marginTop: 8, height: 24, padding: '0 10px', fontSize: 11, color: 'var(--dsw-alias-label-secondary)', background: 'transparent', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: 6, cursor: 'pointer' },
			};
			return function DocReaderToolView(props) {
				try {
					const p = props ?? {};
					const call = p.call ?? p.toolCall ?? p.entry?.call ?? p.node?.call ?? p;
					const name = call?.name ?? p.name ?? '';
					if (name && name !== 'doc_reader') return null;
					const args = call?.arguments ?? call?.args ?? call?.input ?? p.args ?? {};
					const rawResult = call?.result ?? p.result ?? p.output ?? null;
					const text = typeof rawResult === 'string' ? rawResult
						: rawResult?.text ?? rawResult?.content ?? rawResult?.value ?? (rawResult ? JSON.stringify(rawResult) : '');
					const action = String(args?.action ?? '');
					const path = typeof args?.path === 'string' ? args.path : '';
					const file = path ? path.slice(path.lastIndexOf('/') + 1) : '';
					if (!action && !text) return null;
					return h('div', { style: S.wrapper, 'data-doc-reader-tool': action || 'result' },
						h('div', { style: S.head },
							Glyph.logo(12), ` ${t('panel.title')} · ${action || 'result'}`,
							file && h('span', { title: path, style: S.file }, file)),
						text ? h('pre', { style: S.pre }, String(text).slice(0, 1200)) : null,
						path && kindOf(path) ? h('button', {
							type: 'button', style: S.btn,
							onClick: () => { activatePanel(); requestReaderOpen(path); },
						}, t('panel.openInReader')) : null);
				} catch { return null; }
			};
		}

		// ---------- conversation.chat.commandview: /doc slash-command card ----------
		// v0.6.0：与微读插件同款醒目卡片（左侧强调边 + 底色）；结果文本里的绝对
		// 路径渲染为可点击——点击即激活阅读器面板并打开该文档。
		function makeCommandCard(t, activatePanel) {
			const S = {
				card: {
					margin: '6px 0', padding: '10px 12px', borderRadius: 10,
					border: '1px solid rgba(120,150,235,.35)',
					borderLeft: '3px solid rgba(90,130,230,.85)',
					background: 'rgba(120,150,235,.07)',
				},
				cardError: {
					margin: '6px 0', padding: '10px 12px', borderRadius: 10,
					border: '1px solid rgba(220,60,60,.45)',
					borderLeft: '3px solid rgba(220,60,60,.8)',
					background: 'rgba(220,60,60,.06)',
				},
				head: { fontWeight: 600, fontSize: '12.5px', display: 'flex', alignItems: 'center', gap: 6 },
				pre: {
					margin: '6px 0 0', padding: 0, fontFamily: 'inherit', fontSize: '12.5px', lineHeight: 1.65,
					whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'inherit',
				},
				link: {
					color: 'var(--dsw-alias-accent, #4c7cf5)', textDecoration: 'underline',
					textDecorationStyle: 'dotted', cursor: 'pointer', wordBreak: 'break-all',
				},
			};
			const PATH_RE = /(\/(?:Users|private|tmp|var|opt|home)\/[^\s，。;；)）」』"'`《》]+)/g;
			const openInReader = (file) => { activatePanel(); requestReaderOpen(file); };
			const renderTextWithPaths = (text) => {
				const parts = String(text).split(PATH_RE);
				return parts.map((seg, i) => (i % 2 === 1
					? h('span', { key: i, style: S.link, title: t('panel.openInReader') + ': ' + seg, onClick: () => openInReader(seg) }, seg)
					: seg));
			};
			return function DocCommandView(props) {
				try {
					const p = props ?? {};
					let cmd = p.command ?? p.entry?.command;
					if (!cmd && p.node && typeof p.node === 'object') cmd = p.node.command ?? (p.node.kind === 'command' ? p.node : undefined);
					if (!cmd) cmd = p;
					const name = String(cmd?.name ?? p.name ?? '');
					if (name !== 'doc') return null;
					const args = String(cmd?.args ?? cmd?.rawInput ?? p.args ?? '').trim();
					const outcome = cmd?.outcome ?? null;
					const text = String(outcome?.text ?? cmd?.text ?? cmd?.result ?? p.text ?? '');
					const failed = outcome?.kind === 'error';
					return h('div', { style: failed ? S.cardError : S.card },
						h('div', { style: S.head },
							Glyph.logo(12), ` ${t('panel.title')} · ${args ? `${t('panel.commandSearch') ?? '搜索'}「${args}」` : (t('panel.commandRecent') ?? '最近文档')}`,
							failed ? h('span', { style: { color: 'rgba(220,60,60,.9)', fontWeight: 600 } }, ' · 失败') : null),
						text ? h('pre', { style: S.pre }, renderTextWithPaths(text.slice(0, 1200))) : null);
				} catch { return null; }
			};
		}

		// ---------- plugins.row.config: standard settings row ----------
		// Reads/writes the plugin-owned config endpoint; switches apply instantly
		// (no plugin restart). Also outside the panel: inline styles + tokens only.
		function makeRowConfig(t) {
			const S = {
				wrap: { display: 'flex', flexDirection: 'column', gap: 12, padding: '2px 0', fontSize: 12, color: 'var(--dsw-alias-label-primary)' },
				block: { display: 'flex', flexDirection: 'column', gap: 4 },
				row: { display: 'flex', alignItems: 'center', gap: 10 },
				label: { flex: 1, minWidth: 0 },
				hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 },
				muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, padding: '2px 0' },
				switchBase: { width: 34, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer', position: 'relative', flex: 'none', padding: 0, transition: 'background .15s' },
				knob: { position: 'absolute', top: 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .15s', boxShadow: '0 1px 2px rgba(0,0,0,.25)' },
				input: { width: 64, height: 24, fontSize: 12, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-2)', border: '.5px solid var(--dsw-alias-border-l2)', borderRadius: 6, padding: '0 6px', outline: 'none' },
			};
			const TOGGLES = [
				['ctxInjectEnabled', 'cfgCtxInject', 'cfgCtxInjectHint'],
				['autoReloadEnabled', 'cfgAutoReload', 'cfgAutoReloadHint'],
				['toolEnabled', 'cfgTool', 'cfgToolHint'],
				['commandEnabled', 'cfgCommand', 'cfgCommandHint'],
			];
			return function DocReaderRowConfig() {
				const [cfg, setCfg] = useState(null);
				const [failed, setFailed] = useState(false);
				useEffect(() => {
					let alive = true;
					fetch(CONFIG_URL)
						.then((r) => r.json())
						.then((c) => { if (alive && c && typeof c === 'object') setCfg(c); else if (alive) setFailed(true); })
						.catch(() => { if (alive) setFailed(true); });
					return () => { alive = false; };
				}, []);
				const save = (key, value) => {
					fetch(CONFIG_URL, {
						method: 'POST', headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ [key]: value }),
					}).then((r) => (r.ok ? r.json() : null)).then((next) => { if (next && typeof next === 'object') setCfg(next); }).catch(() => { /* keep previous */ });
				};
				if (failed) return h('div', { style: S.muted }, `${t('panel.title')}: unavailable`);
				if (!cfg) return h('div', { style: S.muted }, t('panel.loading'));
				return h('div', { style: S.wrap, 'data-doc-reader-config': '1' },
					TOGGLES.map(([key, labelKey, hintKey]) => h('div', { key, style: S.block },
						h('div', { style: S.row },
							h('span', { style: S.label }, t(`panel.${labelKey}`)),
							h('button', {
								type: 'button', role: 'switch', 'aria-checked': String(cfg[key] === true),
								style: { ...S.switchBase, background: cfg[key] ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)' },
								onClick: () => save(key, !(cfg[key] === true)),
							}, h('span', { style: { ...S.knob, left: cfg[key] ? 16 : 2 } }))),
						h('div', { style: S.hint }, t(`panel.${hintKey}`)))),
					h('div', { style: S.row },
						h('span', { style: S.label }, t('panel.cfgOutlineCount')),
						h('input', {
							type: 'number', min: 1, max: 100, defaultValue: cfg.ctxOutlineCount, style: S.input, 'aria-label': t('panel.cfgOutlineCount'),
							onBlur: (e) => {
								const v = Math.max(1, Math.min(100, Math.round(Number(e.target.value)) || 30));
								e.target.value = String(v);
								if (v !== cfg.ctxOutlineCount) save('ctxOutlineCount', v);
							},
						})));
			};
		}

		// ---------- quote bridge: reader selection → conversation composer ----------
		// `inputActions.insertQuote` is a Session-scoped standard prop; the reader
		// panel is global. A null-rendering bridge component parked in the
		// composer dock captures the actions object for the panel to call.
		const quoteBridge = { actions: null };
		function findInputActions(props) {
			if (!props || typeof props !== 'object') return null;
			for (const value of Object.values(props)) {
				if (value && typeof value === 'object' && typeof value.insertQuote === 'function') return value;
			}
			for (const value of Object.values(props)) {
				if (value && typeof value === 'object') {
					for (const inner of Object.values(value)) {
						if (inner && typeof inner === 'object' && typeof inner.insertQuote === 'function') return inner;
					}
				}
			}
			return null;
		}
		function makeQuoteBridge() {
			return function DocReaderQuoteBridge(props) {
				const found = findInputActions(props);
				useEffect(() => {
					quoteBridge.actions = found;
					return () => { if (quoteBridge.actions === found) quoteBridge.actions = null; };
				}, [found]);
				return null;
			};
		}
		/** Quote a selection into the chat composer; returns 'chat' | 'copied' | null. */
		async function quoteSelectionToChat(displayName, text) {
			const trimmed = String(text ?? '').trim();
			if (!trimmed) return null;
			const quoted = trimmed.split('\n').map((line) => `> ${line}`).join('\n');
			const withSource = `> 《${displayName}》\n${quoted}`.slice(0, 8000);
			const actions = quoteBridge.actions;
			if (actions) {
				try {
					if (actions.insertQuote(withSource)) return 'chat';
				} catch { /* fall back to the clipboard */ }
			}
			try {
				await navigator.clipboard.writeText(withSource);
				return 'copied';
			} catch {
				return null;
			}
		}

		// ---------- input-trigger source: "@doc" recent-documents references ----------
		// Same registration contract the official ui-reference source uses
		// (ctx.get('inputTriggers').registerSource). Candidates come straight from
		// the reader's recent list in localStorage — no Host round-trip.
		function makeDocSource(t, activatePanel) {
			return {
				trigger: '@',
				name: 'doc-reader',
				async candidates(_session, req) {
					const query = String(req?.query ?? '').toLowerCase();
					const recent = readJson(LS.recent, []);
					return recent.slice(0, 12)
						.filter((e) => !query || e.path.toLowerCase().includes(query))
						.map((e) => {
							const name = e.path.slice(e.path.lastIndexOf('/') + 1);
							const slash = e.path.lastIndexOf('/');
							const parent = slash > 0 ? e.path.slice(0, slash) : '';
							return {
								name,
								description: parent || undefined,
								icon: 'file',
								section: t('panel.atDocs'),
								value: JSON.stringify({ path: e.path }),
							};
						});
				},
				onPick({ candidate }) {
					try {
						const value = JSON.parse(candidate?.value);
						if (value && typeof value.path === 'string' && value.path.startsWith('/')) {
							const base = value.path.slice(value.path.lastIndexOf('/') + 1);
							return {
								insert: {
									source: 'doc-reader',
									ref: value.path,
									label: base,
									appearance: 'file',
									clipboardText: value.path,
								},
							};
						}
					} catch { /* malformed value should not happen; ignore */ }
					return undefined;
				},
				openReference(_session, { ref }) {
					if (typeof ref === 'string' && ref.startsWith('/') && kindOf(ref)) {
						activatePanel();
						requestReaderOpen(ref);
						return true;
					}
					return false;
				},
				codec: { clipboardText: (ref) => ref, serialize: async (ref) => ref },
			};
		}

		return {
			inject: ['slots', 'locale', 'layout'],
			apply(ctx) {
				ctx.effect(() => {
					const disposers = Object.entries(LOCALES)
						.map(([locale, dict]) => ctx.locale.register('doc-reader', locale, dict));
					return () => { for (const dispose of disposers.reverse()) dispose(); };
				}, 'dsh-doc-reader: locale');
				const t = ctx.locale.bind('doc-reader');
				ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register(
					{ name: 'main', key: 'doc-reader' },
					makeReaderPanel(t),
				)), 'dsh-doc-reader: main panel');
				ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
					{ name: 'sidebar.panellist', id: 'doc-reader', order: 60, label: t('panel.title') },
					PanelIcon,
				)), 'dsh-doc-reader: sidebar entry');
				// "open in reader" from the document-preview panel and from
				// files the built-in preview cannot render (both pass {absolutePath})
				const activateReader = () => { try { ctx.layout?.selectPanel('doc-reader'); } catch { /* panel already active or layout absent */ } };
				const handoff = makeReaderHandoff(t, activateReader);
				ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register(
					{ name: 'sidebar.right.tab.document.actions', id: 'dsh-doc-reader', locale: 'doc-reader' },
					handoff,
				)), 'dsh-doc-reader: document preview handoff');
				ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.unpreviewable', () => ctx.slots.register(
					{ name: 'sidebar.right.tab.document.unpreviewable', id: 'dsh-doc-reader', locale: 'doc-reader' },
					handoff,
				)), 'dsh-doc-reader: unpreviewable handoff');
				// agent tool result card in the chat flow ("open in reader" bridge)
				ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
					{ name: 'tool.call.toolview', key: 'doc_reader' },
					makeToolCard(t, activateReader),
				)), 'dsh-doc-reader: tool result card');
				// v0.6.0：/doc 斜杠命令反馈卡片（与微读插件同款样式，路径可点击）
				ctx.effect(() => ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
					{ name: 'conversation.chat.commandview', key: 'doc' },
					makeCommandCard(t, activateReader),
				)), 'dsh-doc-reader: /doc command card');
				// v0.6.0：跨插件打开桥——其他插件（如微读命令卡片）派发 cancelable 的
				// dsh:open-in-reader 事件；本插件在时 preventDefault 接管并在面板打开，
				// 不在时事件无人处理，派发方自行回退（如系统默认应用打开）。
				ctx.effect(() => {
					const onOpenInReader = (ev) => {
						const target = typeof ev?.detail?.path === 'string' ? ev.detail.path.trim() : '';
						if (!target) return;
						ev.preventDefault();
						activateReader();
						requestReaderOpen(target);
					};
					window.addEventListener('dsh:open-in-reader', onOpenInReader);
					return () => { window.removeEventListener('dsh:open-in-reader', onOpenInReader); };
				}, 'dsh-doc-reader: open-in-reader bridge');
				// standard settings row on the plugin manager row
				ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register(
					{ name: 'plugins.row.config', key: 'dsh-document-reader#dsh-doc-reader', label: () => t('panel.rowConfig') },
					makeRowConfig(t),
				)), 'dsh-doc-reader: row config');
			// global shortcut: activate the reader and focus its path input
			try {
				ctx.effect(() => ctx.shortcuts.register({
					id: 'doc-reader.open',
					label: () => t('panel.shortcutOpen'),
					aliases: ['doc reader', 'open in reader'],
					defaults: {
						'desktop:macos': { code: 'KeyO', modifiers: ['primary', 'shift'] },
						'desktop:windows': { code: 'KeyO', modifiers: ['primary', 'shift'] },
						'desktop:linux': { code: 'KeyO', modifiers: ['primary', 'shift'] },
						'web:macos': { code: 'KeyO', modifiers: ['primary', 'shift'] },
						'web:windows': { code: 'KeyO', modifiers: ['primary', 'shift'] },
						'web:linux': { code: 'KeyO', modifiers: ['primary', 'shift'] },
					},
					resolve: () => ({
						status: 'handled',
						run: () => {
							focusPathRequested = true;
							try { ctx.layout?.selectPanel('doc-reader'); } catch { /* already active */ }
							try { window.dispatchEvent(new (window.CustomEvent ?? window.Event)('doc-reader:focus-path')); } catch { /* no window */ }
						},
					}),
				}), 'dsh-doc-reader: open shortcut');
			} catch (error) {
				ctx.logger?.warn?.(`doc-reader shortcut registration failed: ${error?.message ?? error}`);
			}
			// quote bridge: capture Session inputActions from the composer dock so the
			// global reader panel can insert a blockquote into the chat draft
			ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
				{ name: 'conversation.composer.dock', id: 'doc-reader-bridge', order: 99 },
				makeQuoteBridge(),
			)), 'dsh-doc-reader: quote bridge');
			// "@doc" reference source in the composer trigger menu (recent documents)
			try {
				const inputTriggers = ctx.get('inputTriggers');
				ctx.effect(() => inputTriggers.registerSource(makeDocSource(t, activateReader)), 'dsh-doc-reader: @doc source');
			} catch (error) {
				ctx.logger?.warn?.(`doc-reader inputTriggers unavailable: ${error?.message ?? error}`);
			}
			},
		};
	},
});
