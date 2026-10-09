// Template rendering shared by the browser (live preview) and the server (actual send).
// Works as a classic <script> (sets window.MailmergeRender) and as a CommonJS module.
(function (root) {
  'use strict';

  // {{name}} / {{ Email }} — also the URL-encoded form an editor can leave inside link hrefs.
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

  // Mail clients give <p> a 1em margin and drop empty paragraphs, so the editor's blank lines vanished
  // and line spacing changed. Keep empty lines (<p><br></p>) and inline the editor's own spacing.
  const INLINE = {
    p: 'margin:0',
    h1: 'font-size:24px;margin:0 0 12px', h2: 'font-size:20px;margin:0 0 10px', h3: 'font-size:17px;margin:0 0 8px',
    ul: 'margin:0 0 8px;padding-left:24px', ol: 'margin:0 0 8px;padding-left:24px',
  };
  function mailFriendly(html) {
    return String(html || '')
      .replace(/<p([^>]*)>\s*<\/p>/gi, '<p$1><br></p>')
      .replace(/<(p|h1|h2|h3|ul|ol)(\s[^>]*)?>/gi, (m, tag, attrs) => {
        attrs = attrs || '';
        if (/\sstyle\s*=/i.test(attrs)) return m;
        return `<${tag}${attrs} style="${INLINE[tag.toLowerCase()]}">`;
      });
  }

  // A full document from the HTML tab is sent as it is.
  function isFullDocument(html) {
    return /<html[\s>]|<body[\s>]|<!doctype/i.test(String(html || ''));
  }

  function wrapDocument(bodyHtml) {
    if (isFullDocument(bodyHtml)) return bodyHtml;
    return (
      '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<style>body{margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328}' +
      'h1{font-size:24px;margin:0 0 12px}h2{font-size:20px;margin:0 0 10px}h3{font-size:17px;margin:0 0 8px}' +
      'p{margin:0}a{color:#0b6bcb}ul,ol{margin:0 0 8px;padding-left:24px}</style>' +
      '</head><body style="margin:0;padding:16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2328">' +
      mailFriendly(bodyHtml) + '</body></html>'
    );
  }

  const api = { PLACEHOLDER, isEmail, escapeHtml, renderSubject, renderBodyHtml, mailFriendly, isFullDocument, wrapDocument };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MailmergeRender = api;
})(typeof self !== 'undefined' ? self : this);
