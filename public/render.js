// Template rendering shared by the browser (live preview) and the server (actual send).
// Works as a classic <script> (sets window.MailmergeRender) and as a CommonJS module.
(function (root) {
  'use strict';

  // {{name}} / {{ Email }} — also the URL-encoded form Quill can leave inside link hrefs.
  const PLACEHOLDER = /\{\{\s*(name|email)\s*\}\}|%7B%7B\s*(name|email)\s*%7D%7D/gi;

  const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;

  function isEmail(s) {
    return typeof s === 'string' && s.length <= 254 && EMAIL_RE.test(s.trim());
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function valueFor(key, recipient) {
    key = key.toLowerCase();
    return String((recipient && recipient[key]) || '').trim();
  }

  // Subject: plain text, no escaping; strip line breaks so a value can't inject headers.
  function renderSubject(subject, recipient) {
    return String(subject || '')
      .replace(PLACEHOLDER, (m, a, b) => valueFor(a || b, recipient))
      .replace(/[\r\n]+/g, ' ');
  }

  // Body: HTML, substituted values are HTML-escaped (inside hrefs, URL-encoded first for href safety).
  function renderBodyHtml(html, recipient) {
    return String(html || '').replace(PLACEHOLDER, (m, a, b) => {
      const v = valueFor(a || b, recipient);
      return b ? escapeHtml(encodeURIComponent(v).replace(/%40/g, '@')) : escapeHtml(v);
    });
  }

  // Quill 2.0.x getSemanticHTML() turns every space into &nbsp;, which stops lines wrapping in
  // mail clients. Turn single &nbsp; back into spaces, keep runs of them as alternating space/&nbsp;.
  function normalizeSpaces(html) {
    return String(html || '').replace(/(?:&nbsp;| )+/g, (run) => {
      const n = (run.match(/&nbsp;| /g) || []).length;
      let out = '';
      for (let i = 0; i < n; i++) out += i % 2 === 0 ? ' ' : '&nbsp;';
      return out;
    });
  }

  function wrapDocument(bodyHtml) {
    return (
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<style>body{margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328}' +
      'h1{font-size:24px;margin:0 0 12px}h2{font-size:20px;margin:0 0 10px}h3{font-size:17px;margin:0 0 8px}' +
      'p{margin:0 0 4px}a{color:#0b6bcb}ul,ol{margin:0 0 8px;padding-left:24px}</style>' +
      '</head><body>' + bodyHtml + '</body></html>'
    );
  }

  const api = { PLACEHOLDER, isEmail, escapeHtml, renderSubject, renderBodyHtml, normalizeSpaces, wrapDocument };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MailmergeRender = api;
})(typeof self !== 'undefined' ? self : this);
