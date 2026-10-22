/* global Jodit, XLSX, MailmergeRender */
(function () {
  'use strict';

  const R = MailmergeRender;
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- storage (localStorage, never the server) ----------

  const KEYS = {
    smtp: 'mailmerge.smtp',
    imap: 'mailmerge.imap',
    template: 'mailmerge.template',
    recipients: 'mailmerge.recipients',
    prefs: 'mailmerge.prefs',
    job: 'mailmerge.job',
  };

  function load(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (e) { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode / full */ }
  }
  function drop(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  }

  const DEFAULT_SMTP = { host: '', port: 587, security: 'starttls', user: '', pass: '', fromAddress: '', fromName: '' };
  const DEFAULT_TEMPLATE = { subject: '', html: '' };
  const DEFAULT_PREFS = { tab: 'sender', delayMs: 1000, previewId: '', testTo: '' };

  let uid = 0;
  const newId = () => 'r' + Date.now().toString(36) + (uid++).toString(36) + Math.random().toString(36).slice(2, 6);

  const state = {
    smtp: Object.assign({}, DEFAULT_SMTP, load(KEYS.smtp, {})),
    imap: load(KEYS.imap, null), // optional, from the settings key; else derived from smtp on the server
    template: Object.assign({}, DEFAULT_TEMPLATE, load(KEYS.template, {})),
    recipients: (load(KEYS.recipients, []) || []).map(cleanRecipient),
    prefs: Object.assign({}, DEFAULT_PREFS, load(KEYS.prefs, {})),
    status: {}, // recipient id -> { status, error }
    job: null,
  };

  function cleanRecipient(r) {
    return {
      id: (r && r.id) || newId(),
      name: String((r && r.name) || '').trim(),
      email: String((r && r.email) || '').trim(),
      selected: !(r && r.selected === false),
    };
  }

  const saveSmtp = () => save(KEYS.smtp, state.smtp);
  const saveImap = () => (state.imap ? save(KEYS.imap, state.imap) : drop(KEYS.imap));
  const saveTemplate = () => save(KEYS.template, state.template);
  const saveRecipients = () => save(KEYS.recipients, state.recipients.map(({ id, name, email, selected }) => ({ id, name, email, selected })));
  const savePrefs = () => save(KEYS.prefs, state.prefs);

  // ---------- toasts + dialog (never alert/confirm/prompt) ----------

  function toast(msg, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), kind === 'err' ? 7000 : 3500);
  }

  function ask({ title, body, actions }) {
    return new Promise((resolve) => {
      const dlg = $('#dialog');
      $('#dialogTitle').textContent = title;
      const b = $('#dialogBody');
      b.innerHTML = '';
      (Array.isArray(body) ? body : [body]).forEach((t) => {
        if (t == null) return;
        if (t instanceof Node) b.appendChild(t);
        else { const p = document.createElement('p'); p.textContent = t; b.appendChild(p); }
      });
      const a = $('#dialogActions');
      a.innerHTML = '';
      const close = (v) => { dlg.hidden = true; document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') close(null); };
      actions.forEach((act) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn ' + (act.kind || '');
        btn.textContent = act.label;
        btn.addEventListener('click', () => close(act.value));
        a.appendChild(btn);
      });
      dlg.onclick = (e) => { if (e.target === dlg) close(null); };
      document.addEventListener('keydown', onKey);
      dlg.hidden = false;
      const primary = a.querySelector('.primary') || a.lastChild;
      if (primary) primary.focus();
    });
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* non-JSON, e.g. an Access login page */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (HTTP ${res.status}).`);
      err.status = res.status;
      throw err;
    }
    if (!data) throw new Error('Unexpected response from the server. If you were logged out, reload the page.');
    return data;
  }

  // ---------- tabs ----------

  function showTab(name) {
    if (!$('#tab-' + name)) name = 'sender';
    $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    $$('.panel').forEach((p) => { p.hidden = p.id !== 'tab-' + name; });
    state.prefs.tab = name;
    savePrefs();
    if (name === 'template') updatePreview();
    if (name === 'send') updateSendPanel();
    if (name === 'sent') openSentTab();
  }
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // ---------- mail account (set only by the settings key) ----------

  function fromLabel() {
    const n = String(state.smtp.fromName || '').trim();
    const a = String(state.smtp.fromAddress || '').trim();
    if (!a) return n || '—';
    return n ? `${n} <${a}>` : a;
  }

  function smtpProblems(s = state.smtp) {
    const p = {};
    if (!String(s.host || '').trim()) p.host = 'the host is missing';
    const port = Number(s.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) p.port = 'the port must be 1–65535';
    if (!['ssl', 'starttls', 'none'].includes(s.security)) p.security = 'security must be SSL/TLS, STARTTLS or none';
    if (!String(s.fromName || '').trim()) p.fromName = 'the sender display name is missing';
    if (!R.isEmail(String(s.fromAddress || '').trim())) p.fromAddress = 'the From address is missing or not valid';
    return p;
  }

  // null when the account is usable, else what is wrong in plain words
  function accountProblem() {
    const s = state.smtp;
    if (!String(s.host || '').trim() && !String(s.fromAddress || '').trim()) return 'No mail account: import a settings key first.';
    const first = Object.values(smtpProblems())[0];
    return first ? `The mail account is incomplete (${first}). Import a new settings key.` : null;
  }

  const SEC = { ssl: 'SSL/TLS', starttls: 'STARTTLS', none: 'no encryption' };

  // what the server uses for IMAP when the key has no `imap` (the same rule as imap.js)
  function imapView() {
    if (state.imap && String(state.imap.host || '').trim()) {
      const sec = state.imap.security || 'ssl';
      return { host: state.imap.host, port: state.imap.port || (sec === 'ssl' ? 993 : 143), security: sec };
    }
    const h = String(state.smtp.host || '');
    return { host: /^smtp\./i.test(h) ? 'imap.' + h.slice(5) : h, port: 993, security: 'ssl' };
  }

  function renderAccount() {
    const problem = accountProblem();
    $('#accountNone').hidden = !problem;
    $('#accountSet').hidden = !!problem;
    $('#verifyStatus').textContent = '';
    $('#verifyImapStatus').textContent = '';
    if (problem) {
      $('#accountNone .note').textContent = problem.startsWith('No mail account')
        ? 'No mail account yet. The mail account is set only by importing the settings key you were given. Sending is off until then.'
        : problem + ' Sending is off until then.';
      return;
    }
    const s = state.smtp;
    const im = imapView();
    $('#acFrom').textContent = fromLabel();
    $('#acSmtp').textContent = `${s.host}:${s.port} (${SEC[s.security] || s.security})`;
    $('#acImap').textContent = `${im.host}:${im.port} (${SEC[im.security] || im.security})`;
    $('#acUser').textContent = s.user || '—';
  }

  $('#goImport').addEventListener('click', () => {
    showTab('sync');
    $('#importText').focus();
  });

  function smtpPayload() {
    const s = state.smtp;
    return {
      host: String(s.host || '').trim(), port: Number(s.port), security: s.security,
      user: String(s.user || '').trim(), pass: String(s.pass || ''),
      fromAddress: String(s.fromAddress || '').trim(), fromName: String(s.fromName || '').trim(),
    };
  }
  function imapPayload() {
    return state.imap ? Object.assign({}, state.imap) : undefined;
  }

  $('#verifyBtn').addEventListener('click', async () => {
    const st = $('#verifyStatus');
    const st2 = $('#verifyImapStatus');
    const problem = accountProblem();
    st2.textContent = '';
    if (problem) { st.className = 'status-line err'; st.textContent = problem; return; }
    const btn = $('#verifyBtn');
    btn.disabled = true;
    st.className = 'status-line';
    st.textContent = 'Connecting…';
    try {
      const r = await api('POST', '/api/verify', { smtp: smtpPayload(), imap: imapPayload(), checkImap: true });
      if (r.ok) { st.className = 'status-line ok'; st.textContent = 'Sending (SMTP): connected and logged in.'; }
      else { st.className = 'status-line err'; st.textContent = 'Sending (SMTP): ' + (r.error || 'connection failed.'); }
      if (r.imap) {
        if (r.imap.ok) { st2.className = 'status-line ok'; st2.textContent = `Sent folder (IMAP): connected, found “${r.imap.folder}”.`; }
        else { st2.className = 'status-line err'; st2.textContent = 'Sent folder (IMAP): ' + (r.imap.error || 'connection failed.'); }
      }
    } catch (err) {
      st.className = 'status-line err';
      st.textContent = err.message;
    } finally { btn.disabled = false; }
  });

  // ---------- template ----------

  // Jodit (MIT) is the whole editor: visual mode plus its own HTML source mode.
  const editor = Jodit.make('#editor', {
    placeholder: 'Dear {{name}},',
    minHeight: 300,
    height: 'auto',
    maxHeight: 640,
    toolbarAdaptive: true,
    askBeforePasteHTML: false,
    askBeforePasteFromWord: false,
    sourceEditor: 'area',            // plain textarea: no Ace loaded from a CDN
    beautifyHTML: false,             // would load js-beautify from a CDN
    showCharsCounter: false,
    showWordsCounter: false,
    showXPathInStatusbar: false,
    buttons: ['paragraph', 'bold', 'italic', 'underline', 'strikethrough', '|', 'brush', 'font', 'fontsize', '|',
      'ul', 'ol', 'align', 'indent', 'outdent', '|', 'link', 'image', 'table', 'hr', '|', 'undo', 'redo', 'eraser', 'source'],
  });

  function editorHtml() {
    const html = editor.value || '';
    return html.replace(/<p><br><\/p>/g, '').trim() ? html : '';
  }

  const modeTabs = $$('.mode-tab');
  function showMode() {
    const html = editor.getMode() === Jodit.MODE_SOURCE;
    modeTabs.forEach((t) => {
      const on = (t.dataset.mode === 'html') === html;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    });
  }
  modeTabs.forEach((t) => t.addEventListener('click', () => {
    editor.setMode(t.dataset.mode === 'html' ? Jodit.MODE_SOURCE : Jodit.MODE_WYSIWYG);
  }));
  editor.events.on('afterSetMode', () => {
    showMode();
    state.prefs.editorMode = editor.getMode() === Jodit.MODE_SOURCE ? 'html' : 'visual';
    savePrefs();
  });

  function loadEditor() {
    editor.value = state.template.html || '';
    editor.setMode(state.prefs.editorMode === 'html' ? Jodit.MODE_SOURCE : Jodit.MODE_WYSIWYG);
    showMode();
  }

  let previewTimer = null;
  editor.events.on('change', () => {
    state.template.html = editorHtml();
    saveTemplate();
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 250);
  });

  const subjectEl = $('#subject');
  subjectEl.addEventListener('input', () => {
    state.template.subject = subjectEl.value;
    saveTemplate();
    updatePreviewMeta();
  });

  // Placeholder insertion goes to whichever of subject/body was focused last.
  let phTarget = 'body';
  function setPhTarget(t) {
    phTarget = t;
    $('#phTarget').textContent = t === 'subject' ? 'into the subject' : 'into the body';
  }
  subjectEl.addEventListener('focus', () => setPhTarget('subject'));
  editor.events.on('focus', () => setPhTarget('body'));

  $$('.chip[data-ph]').forEach((chip) => {
    chip.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret where it is
    chip.addEventListener('click', () => {
      const text = `{{${chip.dataset.ph}}}`;
      if (phTarget === 'subject') {
        const s = subjectEl.selectionStart == null ? subjectEl.value.length : subjectEl.selectionStart;
        const e = subjectEl.selectionEnd == null ? s : subjectEl.selectionEnd;
        subjectEl.setRangeText(text, s, e, 'end');
        subjectEl.focus();
        subjectEl.dispatchEvent(new Event('input'));
      } else {
        editor.s.insertHTML(text);
      }
    });
  });

  // ---------- preview ----------

  const SAMPLE = { id: '', name: 'Jane Doe', email: 'jane@example.com' };

  function previewRecipient() {
    return state.recipients.find((r) => r.id === state.prefs.previewId) || state.recipients[0] || SAMPLE;
  }

  function recipientOptions(select, selectedId) {
    select.innerHTML = '';
    const list = state.recipients.length ? state.recipients.slice(0, 1000) : [SAMPLE];
    for (const r of list) {
      const o = document.createElement('option');
      o.value = r.id;
      o.textContent = r === SAMPLE ? 'Sample: Jane Doe' : (r.name ? `${r.name} — ${r.email}` : r.email || '(empty row)');
      select.appendChild(o);
    }
    const cur = list.find((r) => r.id === selectedId) || list[0];
    select.value = cur.id;
  }

  function refreshRecipientSelects() {
    const id = previewRecipient().id;
    recipientOptions($('#previewFor'), id);
    recipientOptions($('#testAs'), id);
  }

  function updatePreviewMeta() {
    const r = previewRecipient();
    $('#pvFrom').textContent = fromLabel();
    $('#pvTo').textContent = r.name ? `${r.name} <${r.email}>` : r.email;
    $('#pvSubject').textContent = R.renderSubject(state.template.subject, r) || '(no subject)';
  }

  const frame = $('#previewFrame');
  function updatePreview() {
    updatePreviewMeta();
    const r = previewRecipient();
    const body = R.renderBodyHtml(state.template.html, r);
    const doc = R.wrapDocument(body).replace('<head>', '<head><base target="_blank">');
    frame.srcdoc = doc;
  }
  frame.addEventListener('load', () => {
    try {
      const h = frame.contentDocument.documentElement.scrollHeight;
      frame.style.height = Math.max(260, Math.min(h + 4, 2000)) + 'px';
    } catch (e) { /* ignore */ }
  });

  function onRecipientPick(e) {
    state.prefs.previewId = e.target.value;
    savePrefs();
    refreshRecipientSelects();
    updatePreview();
  }
  $('#previewFor').addEventListener('change', onRecipientPick);
  $('#testAs').addEventListener('change', onRecipientPick);

  // ---------- recipients ----------

  const listEl = $('#list');

  function dupSet() {
    const seen = new Map();
    const dups = new Set();
    for (const r of state.recipients) {
      const k = r.email.trim().toLowerCase();
      if (!k) continue;
      if (seen.has(k)) { dups.add(k); } else seen.set(k, true);
    }
    return dups;
  }

  function statusHtml(r, dups) {
    const st = state.status[r.id];
    const wrap = document.createElement('span');
    if (st) {
      const b = document.createElement('span');
      b.className = 'badge ' + st.status;
      b.textContent = { sent: 'Sent', failed: 'Failed', sending: 'Sending…', pending: 'Queued', skipped: 'Not sent' }[st.status] || st.status;
      wrap.appendChild(b);
      if (st.error) {
        const e = document.createElement('span');
        e.className = 'r-error';
        e.textContent = st.error;
        wrap.appendChild(e);
      }
    } else if (r.email && !R.isEmail(r.email)) {
      wrap.innerHTML = '<span class="badge bad">Invalid email</span>';
    } else if (dups.has(r.email.trim().toLowerCase())) {
      wrap.innerHTML = '<span class="badge dup">Duplicate</span>';
    }
    return wrap;
  }

  function rowEl(r, dups) {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.id = r.id;
    row.innerHTML =
      '<input type="checkbox" class="r-chk" aria-label="Include">' +
      '<input type="text" class="r-name" placeholder="Name" aria-label="Name" autocomplete="off">' +
      '<input type="email" class="r-email" placeholder="email@example.com" aria-label="Email" autocomplete="off" autocapitalize="off" spellcheck="false">' +
      '<span class="r-status"></span>' +
      '<button type="button" class="del" aria-label="Delete">×</button>';
    row.querySelector('.r-chk').checked = r.selected;
    row.querySelector('.r-name').value = r.name;
    row.querySelector('.r-email').value = r.email;
    decorateRow(row, r, dups);
    return row;
  }

  function decorateRow(row, r, dups) {
    const key = r.email.trim().toLowerCase();
    row.classList.toggle('unselected', !r.selected);
    row.classList.toggle('invalid', !!r.email && !R.isEmail(r.email));
    row.classList.toggle('dup', !!key && dups.has(key));
    const s = row.querySelector('.r-status');
    s.innerHTML = '';
    const content = statusHtml(r, dups);
    if (content.childNodes.length) s.appendChild(content);
  }

  function renderList() {
    const dups = dupSet();
    const frag = document.createDocumentFragment();
    for (const r of state.recipients) frag.appendChild(rowEl(r, dups));
    listEl.innerHTML = '';
    listEl.appendChild(frag);
    updateListMeta(dups);
  }

  function redecorateAll() {
    const dups = dupSet();
    const byId = new Map(state.recipients.map((r) => [r.id, r]));
    for (const row of listEl.children) {
      const r = byId.get(row.dataset.id);
      if (r) decorateRow(row, r, dups);
    }
    updateListMeta(dups);
  }

  function updateListMeta(dups = dupSet()) {
    const n = state.recipients.length;
    const sel = state.recipients.filter((r) => r.selected).length;
    const invalid = state.recipients.filter((r) => r.email && !R.isEmail(r.email)).length;
    const empty = state.recipients.filter((r) => !r.email).length;
    $('#listCount').textContent = n ? `${sel} of ${n} selected` : '';
    $('#tabCount').textContent = n ? `(${sel})` : '';
    $('#listEmpty').hidden = n > 0;
    $('.list-head').hidden = n === 0;

    const banner = $('#listBanner');
    banner.innerHTML = '';
    if (dups.size) {
      const extra = state.recipients.length - new Set(state.recipients.map((r) => r.email.trim().toLowerCase())).size - (empty > 1 ? empty - 1 : 0);
      const d = document.createElement('div');
      d.className = 'note warn';
      d.textContent = `${dups.size} email address${dups.size > 1 ? 'es appear' : ' appears'} more than once (${extra} extra row${extra === 1 ? '' : 's'}). Each row gets its own email.`;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = 'Remove duplicates';
      b.addEventListener('click', removeDuplicates);
      d.appendChild(b);
      banner.appendChild(d);
    }
    if (invalid) {
      const d = document.createElement('div');
      d.className = 'note err';
      d.textContent = `${invalid} row${invalid > 1 ? 's have' : ' has'} an invalid email address and will be skipped.`;
      banner.appendChild(d);
    }
    refreshRecipientSelects();
    updatePreviewMeta();
  }

  function removeDuplicates() {
    const seen = new Set();
    const before = state.recipients.length;
    state.recipients = state.recipients.filter((r) => {
      const k = r.email.trim().toLowerCase();
      if (!k) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    saveRecipients();
    renderList();
    toast(`Removed ${before - state.recipients.length} duplicate row(s).`, 'ok');
  }

  listEl.addEventListener('input', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const r = state.recipients.find((x) => x.id === row.dataset.id);
    if (!r) return;
    if (e.target.classList.contains('r-name')) r.name = e.target.value;
    else if (e.target.classList.contains('r-email')) { r.email = e.target.value.trim(); delete state.status[r.id]; }
    else if (e.target.classList.contains('r-chk')) r.selected = e.target.checked;
    saveRecipients();
    if (e.target.classList.contains('r-name')) { updatePreviewMeta(); return; }
    redecorateAll();
  });
  listEl.addEventListener('change', (e) => {
    if (e.target.classList.contains('r-name') || e.target.classList.contains('r-email')) {
      const row = e.target.closest('.row');
      const r = state.recipients.find((x) => x.id === row.dataset.id);
      if (r) { r.name = r.name.trim(); e.target.value = e.target.classList.contains('r-name') ? r.name : r.email; saveRecipients(); }
      refreshRecipientSelects();
      if (!$('#tab-template').hidden) updatePreview();
    }
  });
  listEl.addEventListener('click', (e) => {
    const del = e.target.closest('.del');
    if (!del) return;
    const row = del.closest('.row');
    const idx = state.recipients.findIndex((x) => x.id === row.dataset.id);
    if (idx < 0) return;
    const [removed] = state.recipients.splice(idx, 1);
    saveRecipients();
    row.remove();
    redecorateAll();
    undoToast(`Deleted ${removed.email || 'row'}.`, () => {
      state.recipients.splice(idx, 0, removed);
      saveRecipients();
      renderList();
    });
  });

  function undoToast(msg, undo) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg + ' ';
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost small';
    b.style.color = '#9fe0dc';
    b.textContent = 'Undo';
    b.addEventListener('click', () => { el.remove(); undo(); });
    el.appendChild(b);
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  $('#addRow').addEventListener('click', () => {
    const r = cleanRecipient({});
    state.recipients.push(r);
    saveRecipients();
    const row = rowEl(r, dupSet());
    listEl.appendChild(row);
    updateListMeta();
    row.querySelector('.r-name').focus();
  });
  $('#selAll').addEventListener('click', () => { state.recipients.forEach((r) => { r.selected = true; }); saveRecipients(); renderList(); });
  $('#selNone').addEventListener('click', () => { state.recipients.forEach((r) => { r.selected = false; }); saveRecipients(); renderList(); });
  $('#delSel').addEventListener('click', async () => {
    const n = state.recipients.filter((r) => r.selected).length;
    if (!n) { toast('No rows are selected.'); return; }
    const ok = await ask({
      title: `Delete ${n} selected row${n > 1 ? 's' : ''}?`,
      body: 'Unselected rows stay in the list.',
      actions: [{ label: 'Keep', value: false }, { label: 'Delete', value: true, kind: 'primary danger' }],
    });
    if (!ok) return;
    state.recipients = state.recipients.filter((r) => !r.selected);
    saveRecipients();
    renderList();
  });
  $('#clearAll').addEventListener('click', async () => {
    if (!state.recipients.length) return;
    const ok = await ask({
      title: 'Clear the whole list?',
      body: `All ${state.recipients.length} recipients will be removed from this browser.`,
      actions: [{ label: 'Keep', value: false }, { label: 'Clear list', value: true, kind: 'primary danger' }],
    });
    if (!ok) return;
    state.recipients = [];
    state.status = {};
    saveRecipients();
    renderList();
  });

  // ---------- Excel import ----------

  let pendingImport = null;

  function looksLikeHeader(row) {
    return row.some((c) => /^(name|full ?name|e-?mail( address)?|姓名|名字|邮箱|电子邮件)$/i.test(String(c || '').trim()));
  }

  function parseRows(rows) {
    rows = rows.map((r) => (r || []).map((c) => String(c == null ? '' : c).trim()));
    rows = rows.filter((r) => r.some((c) => c));
    if (!rows.length) return { items: [], header: false };

    let header = false;
    let nameCol = 0;
    let emailCol = 1;
    if (looksLikeHeader(rows[0])) {
      header = true;
      const h = rows[0].map((c) => c.toLowerCase());
      const e = h.findIndex((c) => /^(e-?mail( address)?|邮箱|电子邮件)$/.test(c));
      const n = h.findIndex((c) => /^(name|full ?name|姓名|名字)$/.test(c));
      if (e >= 0) emailCol = e;
      if (n >= 0) nameCol = n;
      else nameCol = emailCol === 0 ? 1 : 0;
      rows = rows.slice(1);
    } else {
      // No header: the email column is whichever column looks most like emails.
      const width = Math.max(...rows.map((r) => r.length));
      let best = -1;
      let bestScore = -1;
      for (let c = 0; c < width; c++) {
        const score = rows.filter((r) => R.isEmail(r[c] || '')).length;
        if (score > bestScore) { best = c; bestScore = score; }
      }
      if (bestScore > 0) {
        emailCol = best;
        nameCol = emailCol === 0 ? 1 : 0;
      }
    }
    const items = rows
      .map((r) => ({ name: (r[nameCol] || '').replace(/\s+/g, ' '), email: (r[emailCol] || '').replace(/^mailto:/i, '').trim() }))
      .filter((r) => r.name || r.email);
    return { items, header };
  }

  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    $('#importFileName').textContent = file.name;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', raw: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '', blankrows: false });
      const parsed = parseRows(rows);
      if (!parsed.items.length) throw new Error('No rows found in the first sheet.');
      pendingImport = parsed.items;
      const valid = parsed.items.filter((r) => R.isEmail(r.email)).length;
      const bad = parsed.items.length - valid;
      $('#importSummary').textContent =
        `Found ${parsed.items.length} row${parsed.items.length > 1 ? 's' : ''} in “${wb.SheetNames[0]}”` +
        (parsed.header ? ' (header row skipped)' : '') + '. ' +
        `${valid} valid email${valid === 1 ? '' : 's'}` + (bad ? `, ${bad} invalid.` : '.');
      $('#importResult').hidden = false;
    } catch (err) {
      pendingImport = null;
      $('#importResult').hidden = true;
      toast('Could not read that file: ' + err.message, 'err');
    } finally {
      e.target.value = '';
    }
  });

  function finishImport(mode) {
    if (!pendingImport) return;
    const items = pendingImport.map(cleanRecipient);
    if (mode === 'replace') { state.recipients = items; state.status = {}; }
    else state.recipients = state.recipients.concat(items);
    pendingImport = null;
    $('#importResult').hidden = true;
    $('#importFileName').textContent = 'No file chosen';
    saveRecipients();
    renderList();
    toast(`${mode === 'replace' ? 'Replaced the list with' : 'Added'} ${items.length} recipient${items.length > 1 ? 's' : ''}.`, 'ok');
  }
  $('#importReplace').addEventListener('click', () => finishImport('replace'));
  $('#importAppend').addEventListener('click', () => finishImport('append'));
  $('#importDiscard').addEventListener('click', () => {
    pendingImport = null;
    $('#importResult').hidden = true;
    $('#importFileName').textContent = 'No file chosen';
  });

  $('#templateDl').addEventListener('click', () => {
    const ws = XLSX.utils.aoa_to_sheet([['Name', 'Email'], ['Jane Doe', 'jane@example.com']]);
    ws['!cols'] = [{ wch: 28 }, { wch: 36 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Recipients');
    XLSX.writeFile(wb, 'mailmerge-recipients-template.xlsx');
  });

  // ---------- sending ----------

  function sendable() {
    return state.recipients.filter((r) => r.selected && R.isEmail(r.email));
  }

  function readiness() {
    const items = [];
    const problem = accountProblem();
    items.push({ ok: !problem, text: problem ? problem : `From ${fromLabel()} via ${state.smtp.host}` });
    const subjOk = !!state.template.subject.trim();
    const bodyOk = !!state.template.html.trim();
    items.push({ ok: subjOk && bodyOk, text: subjOk && bodyOk ? `Subject: ${state.template.subject}` : (!subjOk ? 'The subject is empty.' : 'The body is empty.') });
    const list = sendable();
    const selected = state.recipients.filter((r) => r.selected).length;
    items.push({ ok: list.length > 0, text: list.length ? `${list.length} recipient${list.length > 1 ? 's' : ''} will get an email` : 'No selected recipients with a valid email.' });
    if (selected > list.length) items.push({ note: true, text: `${selected - list.length} selected row${selected - list.length > 1 ? 's' : ''} with an invalid email will be skipped.` });
    const dups = dupSet();
    const dupSel = list.length - new Set(list.map((r) => r.email.toLowerCase())).size;
    if (dups.size && dupSel > 0) items.push({ note: true, text: `${dupSel} selected row${dupSel > 1 ? 's are duplicates' : ' is a duplicate'}; those addresses get more than one email.` });
    return { items, ok: items.filter((i) => !i.note).every((i) => i.ok), list };
  }

  function updateSendPanel() {
    const r = readiness();
    const ul = $('#checklist');
    ul.innerHTML = '';
    for (const i of r.items) {
      const li = document.createElement('li');
      li.className = i.note ? 'warnitem' : (i.ok ? '' : 'no');
      li.textContent = i.text;
      ul.appendChild(li);
    }
    const running = state.job && state.job.state === 'running';
    const btn = $('#sendBtn');
    btn.disabled = !r.ok || running;
    btn.textContent = r.list.length ? `Send to ${r.list.length} recipient${r.list.length > 1 ? 's' : ''}` : 'Send';
    $('#cancelBtn').hidden = !running;
    $('#delay').value = state.prefs.delayMs / 1000;
    if (!$('#testTo').value) $('#testTo').value = state.prefs.testTo || state.smtp.fromAddress || '';
  }

  $('#delay').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0) { state.prefs.delayMs = Math.min(60000, Math.round(v * 1000)); savePrefs(); }
  });

  $('#sendBtn').addEventListener('click', async () => {
    const r = readiness();
    if (!r.ok) return;
    const ok = await ask({
      title: `Send ${r.list.length} email${r.list.length > 1 ? 's' : ''}?`,
      body: [
        `From: ${fromLabel()}`,
        `Subject (first recipient): ${R.renderSubject(state.template.subject, r.list[0])}`,
        `One email at a time, ${state.prefs.delayMs / 1000} s apart. Keep this page open to watch progress; sending continues on the server if you close it.`,
      ],
      actions: [{ label: 'Not yet', value: false }, { label: 'Send now', value: true, kind: 'primary' }],
    });
    if (!ok) return;
    $('#sendBtn').disabled = true;
    try {
      const job = await api('POST', '/api/jobs', {
        smtp: smtpPayload(),
        template: { subject: state.template.subject, html: state.template.html },
        recipients: r.list.map((x) => ({ key: x.id, name: x.name.trim(), email: x.email.trim() })),
        delayMs: state.prefs.delayMs,
      });
      // Clear old statuses for the rows in this run.
      for (const x of r.list) delete state.status[x.id];
      save(KEYS.job, { id: job.id });
      onJob(job);
      pollJob(job.id);
    } catch (err) {
      toast(err.message, 'err');
      updateSendPanel();
    }
  });

  $('#cancelBtn').addEventListener('click', async () => {
    if (!state.job) return;
    try {
      const job = await api('POST', `/api/jobs/${state.job.id}/cancel`);
      onJob(job);
      toast('Cancelling after the current email…');
    } catch (err) { toast(err.message, 'err'); }
  });

  let pollTimer = null;
  function pollJob(id) {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try {
        const job = await api('GET', `/api/jobs/${id}`);
        onJob(job);
        if (job.state === 'running') pollJob(id);
      } catch (err) {
        if (err.status === 404) {
          drop(KEYS.job);
          state.job = null;
          $('#sendSummary').innerHTML = '';
          updateSendPanel();
        } else pollJob(id); // transient network error: keep trying
      }
    }, 1000);
  }

  function onJob(job) {
    state.job = job;
    const known = new Set(state.recipients.map((r) => r.id));
    for (const it of job.items) {
      if (known.has(it.key)) state.status[it.key] = { status: it.status, error: it.error };
    }
    $('#progress').hidden = false;
    const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
    $('#progressBar').style.width = pct + '%';
    $('#progressText').textContent = `${job.done} of ${job.total} processed · ${job.sent} sent · ${job.failed} failed` +
      (job.state === 'running' ? '' : job.state === 'cancelled' ? ' · cancelled' : '');

    const sum = $('#sendSummary');
    sum.innerHTML = '';
    if (job.state !== 'running') {
      const d = document.createElement('div');
      const skipped = job.items.filter((i) => i.status === 'skipped').length;
      d.className = 'note ' + (job.state === 'error' || job.failed ? 'err' : job.state === 'cancelled' ? 'warn' : 'ok');
      d.textContent = job.state === 'error'
        ? `Sending stopped: ${job.error}`
        : `${job.state === 'cancelled' ? 'Cancelled. ' : 'Finished. '}${job.sent} sent, ${job.failed} failed${skipped ? `, ${skipped} not sent` : ''}.`;
      sum.appendChild(d);
      drop(KEYS.job);
    }

    const res = $('#results');
    res.innerHTML = '';
    const names = new Map(state.recipients.map((r) => [r.id, r.name]));
    for (const it of job.items) {
      const row = document.createElement('div');
      row.className = 'res';
      const who = document.createElement('div');
      who.className = 'who';
      const nm = names.get(it.key);
      who.textContent = nm ? `${nm} <${it.email}>` : it.email;
      if (it.error) {
        const e = document.createElement('span');
        e.className = 'r-error';
        e.textContent = it.error;
        who.appendChild(e);
      }
      const b = document.createElement('span');
      b.className = 'badge ' + it.status;
      b.textContent = { sent: 'Sent', failed: 'Failed', sending: 'Sending…', pending: 'Queued', skipped: 'Not sent' }[it.status] || it.status;
      row.appendChild(who);
      row.appendChild(b);
      res.appendChild(row);
    }
    redecorateAll();
    updateSendPanel();
  }

  $('#testTo').addEventListener('input', (e) => { state.prefs.testTo = e.target.value.trim(); savePrefs(); });

  $('#testBtn').addEventListener('click', async () => {
    const st = $('#testStatus');
    const to = $('#testTo').value.trim();
    let problem = accountProblem();
    if (!problem && !state.template.subject.trim()) problem = 'The subject is empty.';
    if (!problem && !state.template.html.trim()) problem = 'The body is empty.';
    if (!problem && !R.isEmail(to)) problem = 'Type a valid address to send the test to.';
    if (problem) { st.className = 'status-line err'; st.textContent = problem; return; }
    const r = previewRecipient();
    const btn = $('#testBtn');
    btn.disabled = true;
    st.className = 'status-line';
    st.textContent = 'Sending…';
    try {
      const res = await api('POST', '/api/send-test', {
        smtp: smtpPayload(),
        template: { subject: state.template.subject, html: state.template.html },
        to,
        sample: { name: r.name, email: r.email },
      });
      if (res.ok) { st.className = 'status-line ok'; st.textContent = `Sent to ${to}.`; }
      else { st.className = 'status-line err'; st.textContent = res.error || 'Sending failed.'; }
    } catch (err) {
      st.className = 'status-line err';
      st.textContent = err.message;
    } finally { btn.disabled = false; }
  });

  // ---------- settings sync key ----------

  function toB64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function fromB64(b64) {
    let s = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  $('#exportBtn').addEventListener('click', () => {
    const payload = {
      app: 'mailmerge',
      v: 1,
      exportedAt: new Date().toISOString(),
      smtp: smtpPayload(),
      imap: imapPayload(),
      template: { subject: state.template.subject, html: state.template.html },
      recipients: state.recipients.map(({ name, email, selected }) => ({ name, email, selected })),
      prefs: { delayMs: state.prefs.delayMs, testTo: state.prefs.testTo },
    };
    $('#exportText').value = toB64(JSON.stringify(payload));
    $('#exportOut').hidden = false;
  });
  $('#hideExport').addEventListener('click', () => { $('#exportText').value = ''; $('#exportOut').hidden = true; });
  $('#copyBtn').addEventListener('click', async () => {
    const ta = $('#exportText');
    try {
      await navigator.clipboard.writeText(ta.value);
      toast('Copied.', 'ok');
    } catch (e) {
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); toast('Copied.', 'ok'); } catch (e2) { toast('Select the text and copy it manually.'); }
    }
  });

  $('#importBtn').addEventListener('click', async () => {
    const raw = $('#importText').value.trim();
    if (!raw) { toast('Paste a settings key first.'); return; }
    let data;
    try {
      data = JSON.parse(fromB64(raw));
      if (!data || data.app !== 'mailmerge' || typeof data.v !== 'number') throw new Error('not a mailmerge settings key');
      if (data.v > 1) throw new Error(`it was made by a newer version (v${data.v})`);
    } catch (err) {
      toast('That is not a valid settings key: ' + err.message, 'err');
      return;
    }
    // Only what the key holds replaces what is here; a key without a mail account keeps the current one.
    const hasSmtp = !!(data.smtp && typeof data.smtp === 'object' &&
      (String(data.smtp.host || '').trim() || String(data.smtp.fromAddress || '').trim()));
    const hasTemplate = !!(data.template && typeof data.template === 'object');
    const hasRecipients = Array.isArray(data.recipients);
    let newSmtp = null;
    let newImap = null;
    if (hasSmtp) {
      newSmtp = Object.assign({}, DEFAULT_SMTP, data.smtp);
      const bad = Object.values(smtpProblems(newSmtp))[0];
      if (bad) { toast(`That key holds an incomplete mail account: ${bad}.`, 'err'); return; }
      if (data.imap && typeof data.imap === 'object' && String(data.imap.host || '').trim()) {
        newImap = {};
        for (const k of ['host', 'port', 'security', 'user', 'pass']) {
          if (data.imap[k] != null && data.imap[k] !== '') newImap[k] = k === 'port' ? Number(data.imap[k]) : String(data.imap[k]);
        }
      }
    }
    if (!hasSmtp && !hasTemplate && !hasRecipients) { toast('That key holds no mail account, template or recipients.', 'err'); return; }
    const n = hasRecipients ? data.recipients.length : 0;
    const lines = [];
    lines.push(hasSmtp
      ? `Mail account: ${newSmtp.fromName} <${newSmtp.fromAddress}> via ${newSmtp.host}`
      : 'Mail account: not in this key, the current one is kept.');
    if (hasTemplate) lines.push(`Template subject: ${data.template.subject || '—'}`);
    if (hasRecipients) lines.push(`${n} recipient${n === 1 ? '' : 's'}`);
    lines.push('These replace what is saved in this browser.');
    const ok = await ask({
      title: 'Import this settings key?',
      body: lines,
      actions: [{ label: 'Keep current', value: false }, { label: 'Replace', value: true, kind: 'primary' }],
    });
    if (!ok) return;
    if (hasSmtp) {
      state.smtp = newSmtp;
      state.imap = newImap;
      saveSmtp();
      saveImap();
      resetSent();
    }
    if (hasTemplate) {
      state.template = { subject: String(data.template.subject || ''), html: String(data.template.html || '') };
      saveTemplate();
    }
    if (hasRecipients) {
      state.recipients = data.recipients.map(cleanRecipient);
      state.status = {};
      saveRecipients();
    }
    state.prefs = Object.assign({}, state.prefs, (data.prefs && typeof data.prefs === 'object') ? data.prefs : {});
    savePrefs();
    $('#importText').value = '';
    $('#testTo').value = state.prefs.testTo || '';
    initFromState();
    toast('Settings imported.', 'ok');
  });

  // ---------- sent folder (IMAP) ----------

  const sent = { items: [], total: 0, folder: '', hasMore: false, loading: false, loaded: false, openUid: null, gen: 0 };

  function resetSent() {
    Object.assign(sent, { items: [], total: 0, folder: '', hasMore: false, loaded: false, gen: sent.gen + 1 });
    $('#sentList').innerHTML = '';
    $('#sentMoreWrap').hidden = true;
    $('#sentEmpty').hidden = true;
    closeSentView();
  }

  function fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleString(undefined, { year: sameYear ? undefined : 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function addrText(list) {
    return (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ') || '(no recipient)';
  }

  function openSentTab() {
    const problem = accountProblem();
    if (problem) {
      const banner = $('#sentBanner');
      banner.innerHTML = '';
      const d = document.createElement('div');
      d.className = 'note warn';
      d.textContent = problem;
      banner.appendChild(d);
      return;
    }
    if (!sent.loaded && !sent.loading) loadSent(false);
  }

  async function loadSent(more) {
    if (sent.loading) return;
    sent.loading = true;
    const gen = sent.gen;
    const banner = $('#sentBanner');
    banner.innerHTML = '';
    const moreBtn = $('#sentMore');
    const refresh = $('#sentRefresh');
    refresh.disabled = true;
    moreBtn.disabled = true;
    if (!more) {
      $('#sentList').innerHTML = '<p class="muted loading">Loading the Sent folder…</p>';
      $('#sentEmpty').hidden = true;
      $('#sentMoreWrap').hidden = true;
    } else moreBtn.textContent = 'Loading…';
    try {
      const r = await api('POST', '/api/sent', { smtp: smtpPayload(), imap: imapPayload(), offset: more ? sent.items.length : 0, limit: 50 });
      if (gen !== sent.gen) return; // the account changed meanwhile
      if (!r.ok) throw new Error(r.error || 'Could not read the Sent folder.');
      if (!more) sent.items = [];
      const seen = new Set(sent.items.map((x) => x.uid));
      for (const it of r.items) if (!seen.has(it.uid)) sent.items.push(it);
      Object.assign(sent, { total: r.total, folder: r.folder, hasMore: r.hasMore, loaded: true });
      renderSent();
    } catch (err) {
      if (gen !== sent.gen) return;
      if (!more) $('#sentList').innerHTML = '';
      const d = document.createElement('div');
      d.className = 'note err';
      d.textContent = err.message;
      banner.appendChild(d);
    } finally {
      sent.loading = false;
      refresh.disabled = false;
      moreBtn.disabled = false;
      moreBtn.textContent = 'Load more';
    }
  }

  function bounceText(b) {
    return [b.address, b.reason].filter(Boolean).join(' — ');
  }

  function renderSent() {
    const list = $('#sentList');
    list.innerHTML = '';
    const bounced = sent.items.filter((x) => x.status === 'bounced').length;
    $('#sentInfo').textContent = `Folder “${sent.folder}”: ${sent.items.length} of ${sent.total} shown, newest first` +
      (bounced ? `, ${bounced} bounced` : '') + '. Includes mail sent outside this app. Bounces are looked up in the inbox.';
    for (const it of sent.items) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'sent-row' + (it.uid === sent.openUid ? ' open' : '') + (it.status === 'bounced' ? ' bounced' : '');
      row.dataset.uid = it.uid;
      const top = document.createElement('div');
      top.className = 'sr-top';
      const to = document.createElement('span');
      to.className = 'sr-to';
      to.textContent = addrText(it.to);
      const date = document.createElement('span');
      date.className = 'sr-date';
      date.textContent = fmtDate(it.date);
      top.append(to, date);
      const subj = document.createElement('div');
      subj.className = 'sr-subject';
      subj.textContent = it.subject || '(no subject)';
      const st = document.createElement('div');
      st.className = 'sr-status';
      const b = document.createElement('span');
      b.className = 'badge ' + (it.status === 'bounced' ? 'failed' : 'notbounced');
      b.textContent = it.status === 'bounced' ? 'Bounced' : 'Not bounced';
      st.appendChild(b);
      for (const x of it.bounces || []) {
        const e = document.createElement('span');
        e.className = 'r-error';
        e.textContent = bounceText(x);
        st.appendChild(e);
      }
      row.append(top, subj, st);
      list.appendChild(row);
    }
    $('#sentEmpty').hidden = sent.items.length > 0;
    $('#sentMoreWrap').hidden = !sent.hasMore;
  }

  $('#sentRefresh').addEventListener('click', () => {
    if (accountProblem()) { openSentTab(); return; }
    closeSentView();
    loadSent(false);
  });
  $('#sentMore').addEventListener('click', () => loadSent(true));
  $('#sentList').addEventListener('click', (e) => {
    const row = e.target.closest('.sent-row');
    if (row) openSentMessage(Number(row.dataset.uid));
  });

  const sentFrame = $('#sentFrame');
  function closeSentView() {
    sent.openUid = null;
    $('#sentView').hidden = true;
    $('#tab-sent').classList.remove('viewing');
    sentFrame.srcdoc = '';
    $$('.sent-row.open').forEach((r) => r.classList.remove('open'));
  }
  $('#sentBack').addEventListener('click', () => {
    const uid = sent.openUid;
    closeSentView();
    const row = $(`.sent-row[data-uid="${uid}"]`);
    if (row) row.scrollIntoView({ block: 'center' });
  });

  // The message shows in an iframe that runs no scripts: sandbox without allow-scripts, plus a CSP.
  // (allow-same-origin without allow-scripts only lets this page size the frame; the message can't run code.)
  sentFrame.addEventListener('load', () => {
    try {
      const h = sentFrame.contentDocument.documentElement.scrollHeight;
      sentFrame.style.height = Math.max(240, Math.min(h + 4, 4000)) + 'px';
    } catch (e) { /* ignore */ }
  });
  function messageDoc(html) {
    const head = '<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src \'none\'; object-src \'none\'; frame-src \'none\'">' +
      '<base target="_blank"><style>body{font:15px/1.5 Arial,Helvetica,sans-serif;color:#1f2328;margin:12px;overflow-wrap:anywhere}img{max-width:100%;height:auto}pre{white-space:pre-wrap;font:inherit}</style>';
    if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${head}`);
    if (/<html[\s>]/i.test(html)) return html.replace(/<html([^>]*)>/i, `<html$1><head>${head}</head>`);
    return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
  }
  function escapeHtml(t) {
    return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function openSentMessage(uid) {
    const it = sent.items.find((x) => x.uid === uid);
    if (!it) return;
    sent.openUid = uid;
    $$('.sent-row').forEach((r) => r.classList.toggle('open', Number(r.dataset.uid) === uid));
    $('#tab-sent').classList.add('viewing');
    $('#sentView').hidden = false;
    $('#svSubject').textContent = it.subject || '(no subject)';
    $('#svFrom').textContent = fromLabel();
    $('#svTo').textContent = addrText(it.to);
    $('#svCc').textContent = addrText(it.cc);
    $('#svCcRow').hidden = !(it.cc && it.cc.length);
    $('#svDate').textContent = fmtDate(it.date);
    const bb = $('#svBounce');
    bb.innerHTML = '';
    const note = document.createElement('div');
    note.className = 'note ' + (it.status === 'bounced' ? 'err' : 'ok');
    note.textContent = it.status === 'bounced'
      ? 'Bounced: ' + it.bounces.map(bounceText).join('; ')
      : 'Not bounced: there is no bounce for this message in the inbox.';
    bb.appendChild(note);
    $('#svAttach').hidden = true;
    sentFrame.srcdoc = messageDoc('<p style="color:#5b6470">Loading…</p>');
    if (window.matchMedia('(max-width: 899px)').matches) window.scrollTo(0, 0);
    try {
      const m = await api('POST', '/api/sent/message', { smtp: smtpPayload(), imap: imapPayload(), uid });
      if (sent.openUid !== uid) return;
      if (!m.ok) throw new Error(m.error || 'Could not open the message.');
      $('#svFrom').textContent = m.from || fromLabel();
      if (m.to) $('#svTo').textContent = m.to;
      if (m.cc) { $('#svCc').textContent = m.cc; $('#svCcRow').hidden = false; }
      sentFrame.srcdoc = messageDoc(m.html || `<pre>${escapeHtml(m.text || '')}</pre>`);
      if (m.attachments && m.attachments.length) {
        $('#svAttach').textContent = 'Attachments: ' + m.attachments.map((a) => `${a.filename} (${Math.max(1, Math.round(a.size / 1024))} KB)`).join(', ');
        $('#svAttach').hidden = false;
      }
    } catch (err) {
      if (sent.openUid !== uid) return;
      sentFrame.srcdoc = messageDoc(`<p style="color:#b42318">${escapeHtml(err.message)}</p>`);
    }
  }

  // ---------- boot ----------

  function initFromState() {
    renderAccount();
    subjectEl.value = state.template.subject;
    loadEditor();
    renderList();
    updatePreview();
    updateSendPanel();
  }

  initFromState();
  showTab(state.prefs.tab);

  const activeJob = load(KEYS.job, null);
  if (activeJob && activeJob.id) pollJob(activeJob.id);
})();
