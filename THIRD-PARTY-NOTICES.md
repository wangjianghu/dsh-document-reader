# Third-party notices

This distribution bundles compiled code from the following open-source
libraries. Each remains under its own license; upstream notices ship with
their npm distributions.

| Library | Bundled in | License | Upstream |
|---|---|---|---|
| markdown-it | client.vendor.js | MIT | https://github.com/markdown-it/markdown-it |
| jszip | client.vendor.js | MIT OR GPL-3.0-or-later (MIT option) | https://github.com/Stuk/jszip |
| docx-preview | client.vendor.js | Apache-2.0 | https://github.com/VolodymyrBaydalka/docxjs |
| pdfjs-dist | dependency (client.pdfjs.js loader) | Apache-2.0 | https://github.com/mozilla/pdf.js |

Office conversion uses the LibreOffice engine shipped inside the DSH
installation at runtime (no bundling here).
