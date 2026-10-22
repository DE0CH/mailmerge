'use strict';

// The Sent tab: read the mailbox's Sent folder over IMAP and find the bounces for its messages in INBOX.
// Stateless like the rest of the server: every call logs in with the credentials the browser sends, does
// its work and logs out.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');

const MAX_PAGE = 200;
const MAX_CANDIDATES = 500;            // bounce-looking INBOX messages read per request
const CANDIDATE_BYTES = 256 * 1024;    // bytes read of each one (the original's headers come early)
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

class ImapInputError extends Error {}

// ---------- settings ----------

// `imap` from the settings key, or derived from the SMTP account: smtp.X -> imap.X, 993 SSL/TLS, same login.
function parseImap(raw, smtp) {
  if (raw && typeof raw === 'object' && String(raw.host || '').trim()) {
    const host = String(raw.host).trim().slice(0, 255);
    const security = raw.security == null || raw.security === '' ? 'ssl' : String(raw.security);
    const port = raw.port == null || raw.port === '' ? (security === 'ssl' ? 993 : 143) : Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ImapInputError('IMAP port must be 1–65535.');
    if (!['ssl', 'starttls', 'none'].includes(security)) throw new ImapInputError('IMAP security must be SSL/TLS, STARTTLS or none.');
    return {
      host, port, security,
      user: typeof raw.user === 'string' ? raw.user.trim().slice(0, 320) : smtp.user,
      pass: typeof raw.pass === 'string' ? raw.pass.slice(0, 1000) : smtp.pass,
    };
  }
  return { host: deriveImapHost(smtp.host), port: 993, security: 'ssl', user: smtp.user, pass: smtp.pass };
}

function deriveImapHost(smtpHost) {
  return /^smtp\./i.test(smtpHost) ? 'imap.' + smtpHost.slice(5) : smtpHost;
}

function makeClient(imap) {
  const client = new ImapFlow({
    host: imap.host,
    port: imap.port,
    secure: imap.security === 'ssl',
    doSTARTTLS: imap.security === 'starttls' ? true : imap.security === 'none' ? false : undefined,
    auth: { user: imap.user, pass: imap.pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
    disableAutoIdle: true,
  });
  client.on('error', () => { /* reported through the awaited call that fails */ });
  return client;
}

async function withClient(imap, fn) {
  const client = makeClient(imap);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch (e) { client.close(); }
  }
}

function imapErrText(err) {
  if (!err) return 'IMAP error';
  if (err.authenticationFailed) return 'IMAP login failed: ' + (err.responseText || 'wrong username or password');
  const msg = err.responseText || err.message || String(err);
  return ('IMAP: ' + msg).slice(0, 500);
}

// ---------- folders ----------

const SENT_NAMES = /^(sent|sent items|sent messages|sent mail|已发送|已發送|已傳送|寄件備份|已发邮件)$/i;

async function findSent(client) {
  const list = await client.list();
  const usable = list.filter((m) => !m.flags || !m.flags.has('\\Noselect'));
  const sent = usable.find((m) => m.specialUse === '\\Sent' && m.specialUseSource !== 'name')
    || usable.find((m) => m.specialUse === '\\Sent')
    || usable.find((m) => SENT_NAMES.test(m.name));
  if (!sent) throw new Error('This mailbox has no Sent folder.');
  return { path: sent.path, name: sent.name };
}

// ---------- message ids ----------

function normId(v) {
  if (!v) return '';
  let s = String(v).trim();
  const m = s.match(/<([^<>]+)>/);
  if (m) s = m[1];
  return s.replace(/^<|>$/g, '').trim().toLowerCase();
}

function idsIn(value) {
  // a header value may hold several ids (References) or one without brackets (Feishu's In-Reply-To)
  const s = String(value || '');
  const bracketed = s.match(/<[^<>\s]+>/g);
  if (bracketed) return bracketed.map(normId);
  return s.split(/\s+/).map(normId).filter((x) => x.includes('@'));
}

function headerBlock(text) {
  const end = text.search(/\r?\n\r?\n/);
  return (end < 0 ? text : text.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
}

function headerValues(block, name) {
  const re = new RegExp('^' + name + ':[ \\t]*(.*)$', 'gim');
  const out = [];
  let m;
  while ((m = re.exec(block))) out.push(m[1].trim());
  return out;
}

// ---------- bounce detection ----------

const DAEMON = /^(mailer-daemon|mail-daemon|mailerdaemon|postmaster)$/i;
const BOUNCE_SUBJECT = /undeliver|undelivered|delivery (status|failure|has failed|failed|notification)|returned mail|failure notice|mail delivery|non-?delivery|退信|未送达|未送達|投递失败|投遞失敗|发送失败|發送失敗|无法送达|無法送達/i;

function looksLikeBounce(envelope) {
  const from = (envelope && envelope.from && envelope.from[0] && envelope.from[0].address) || '';
  const local = from.split('@')[0];
  return DAEMON.test(local) || BOUNCE_SUBJECT.test((envelope && envelope.subject) || '');
}

// Parse a bounce notice. Returns null when it is not a failure (e.g. a "delayed" DSN), else
// { precise: Set of original Message-IDs, haystack: text to search for ids, failures: [{address, reason}] }.
async function analyzeBounce(raw) {
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextLinks: true, skipImageLinks: true });
  const precise = new Set();
  const failures = [];
  const texts = [raw.toString('utf8')];
  if (parsed.text) texts.push(parsed.text);

  for (const id of idsIn(parsed.inReplyTo)) precise.add(id);

  const rawText = texts[0];
  // RFC 3464: mailparser folds message/delivery-status into .text (or keeps it as an attachment)
  const isDsn = /content-type:\s*message\/(global-)?delivery-status/i.test(rawText);
  const dsnSources = [];
  for (const att of parsed.attachments || []) {
    const ct = String(att.contentType || '').toLowerCase();
    const body = att.content ? att.content.toString('utf8') : '';
    if (body) texts.push(body);
    if (/^(message\/rfc822|text\/rfc822-headers|message\/rfc822-headers|message\/global|message\/global-headers)$/.test(ct)) {
      for (const v of headerValues(headerBlock(body), 'Message-ID')) idsIn(v).forEach((id) => precise.add(id));
    } else if (/delivery-status/.test(ct)) dsnSources.push(body);
  }
  let dsnFailed = false;
  if (isDsn) {
    dsnSources.push(parsed.text || '');
    for (const src of dsnSources) {
      const blocks = src.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((b) => b.replace(/\n[ \t]+/g, ' '));
      for (const b of blocks) {
        const recipient = headerValues(b, 'Final-Recipient')[0] || headerValues(b, 'Original-Recipient')[0];
        if (!recipient) continue;
        const action = (headerValues(b, 'Action')[0] || '').toLowerCase();
        if (action && action !== 'failed') continue;
        dsnFailed = true;
        const address = recipient.replace(/^[^;]*;\s*/, '').replace(/^<|>$/g, '').trim();
        const status = headerValues(b, 'Status')[0] || '';
        const diag = (headerValues(b, 'Diagnostic-Code')[0] || '').replace(/^[^;]*;\s*/, '');
        const reason = (diag ? (status && !diag.includes(status) ? `${status} ${diag}` : diag) : status).slice(0, 500) || 'Delivery failed';
        if (!failures.some((f) => f.address === address && f.reason === reason)) failures.push({ address, reason });
      }
    }
  }
  if (isDsn && !dsnFailed) return null;

  for (const t of texts) {
    for (const v of headerValues(t, '(?:X-)?Original-Message-ID')) idsIn(v).forEach((id) => precise.add(id));
  }

  if (!failures.length) {
    // Feishu: "Email delivery failed <address>"; others: the first lines of the notice
    const text = (parsed.text || '').replace(/\r/g, '');
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    const fromAddr = ((parsed.from && parsed.from.value && parsed.from.value[0] && parsed.from.value[0].address) || '').toLowerCase();
    const emails = (text.match(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [])
      .filter((e) => e.toLowerCase() !== fromAddr && !DAEMON.test(e.split('@')[0]));
    const reasonLine = lines.find((l) => /fail|undeliver|reject|not exist|unknown|invalid|denied|退信|失败|失敗|不存在|拒绝|拒絕/i.test(l)) || lines[0] || '';
    failures.push({ address: emails[0] || '', reason: (reasonLine || parsed.subject || 'Delivery failed').slice(0, 500) });
  }
  return { precise, haystack: texts.join('\n').toLowerCase(), failures, date: parsed.date || null };
}

async function findBounces(client, items) {
  const byId = new Map();
  for (const it of items) if (it.messageId) byId.set(normId(it.messageId), it);
  if (!byId.size) return;

  const oldest = items.reduce((min, it) => {
    const d = new Date(it.date || 0).getTime();
    return d && d < min ? d : min;
  }, Date.now());
  const since = new Date(oldest - 2 * 24 * 3600 * 1000);

  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const uids = await client.search({ since }, { uid: true });
    if (!uids || !uids.length) return;
    // Envelopes are matched in code; the server's HEADER search is not reliable on every host (Feishu).
    const candidates = [];
    for await (const m of client.fetch(uids, { uid: true, envelope: true }, { uid: true })) {
      if (looksLikeBounce(m.envelope)) candidates.push(m.uid);
    }
    const pick = candidates.slice(-MAX_CANDIDATES);
    if (!pick.length) return;
    const raws = [];
    for await (const m of client.fetch(pick, { uid: true, source: { maxLength: CANDIDATE_BYTES } }, { uid: true })) {
      if (m.source) raws.push(m.source);
    }
    for (const raw of raws) {
      let b;
      try { b = await analyzeBounce(raw); } catch (e) { continue; }
      if (!b) continue;
      let matched = [...b.precise].map((id) => byId.get(id)).filter(Boolean);
      if (!matched.length) {
        // fallback: the original Message-ID anywhere in the notice
        matched = [...byId.entries()].filter(([id]) => b.haystack.includes(id)).map(([, it]) => it);
      }
      for (const it of matched) {
        for (const f of b.failures) {
          if (!it.bounces.some((x) => x.address === f.address && x.reason === f.reason)) {
            it.bounces.push({ address: f.address, reason: f.reason, date: b.date ? new Date(b.date).toISOString() : null });
          }
        }
      }
    }
  } finally {
    lock.release();
  }
}

// ---------- API ----------

function addrList(list) {
  return (list || []).map((a) => ({ name: a.name || '', address: a.address || '' }));
}

async function listSent(imap, { offset = 0, limit = 50 } = {}) {
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(Number(limit) || 50)));
  return withClient(imap, async (client) => {
    const folder = await findSent(client);
    const items = [];
    let total = 0;
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    try {
      total = client.mailbox.exists;
      const end = total - offset;
      if (end >= 1) {
        const start = Math.max(1, end - limit + 1);
        for await (const m of client.fetch(`${start}:${end}`, { uid: true, envelope: true, internalDate: true, size: true })) {
          const e = m.envelope || {};
          items.push({
            uid: m.uid,
            seq: m.seq,
            date: new Date(e.date || m.internalDate || 0).toISOString(),
            subject: e.subject || '',
            to: addrList(e.to),
            cc: addrList(e.cc),
            messageId: e.messageId || '',
            size: m.size || 0,
            bounces: [],
          });
        }
      }
    } finally {
      lock.release();
    }
    items.sort((a, b) => b.seq - a.seq); // newest (last added) first
    await findBounces(client, items);
    return {
      ok: true,
      folder: folder.name,
      total,
      offset,
      hasMore: offset + items.length < total,
      items: items.map(({ seq, ...rest }) => ({ ...rest, status: rest.bounces.length ? 'bounced' : 'not-bounced' })),
    };
  });
}

async function getSentMessage(imap, uid) {
  uid = Number(uid);
  if (!Number.isInteger(uid) || uid < 1) throw new ImapInputError('A message uid is required.');
  return withClient(imap, async (client) => {
    const folder = await findSent(client);
    const lock = await client.getMailboxLock(folder.path, { readOnly: true });
    let source;
    try {
      const m = await client.fetchOne(String(uid), { uid: true, size: true, source: { maxLength: MAX_MESSAGE_BYTES } }, { uid: true });
      if (!m || !m.source) throw new Error('That message is no longer in the Sent folder.');
      source = m.source;
    } finally {
      lock.release();
    }
    const p = await simpleParser(source);
    const fmt = (a) => (a ? [].concat(a).flatMap((x) => x.value || []).map((v) => (v.name ? `${v.name} <${v.address}>` : v.address)).join(', ') : '');
    return {
      ok: true,
      uid,
      subject: p.subject || '',
      from: fmt(p.from),
      to: fmt(p.to),
      cc: fmt(p.cc),
      bcc: fmt(p.bcc),
      date: p.date ? p.date.toISOString() : null,
      messageId: p.messageId || '',
      html: p.html || (p.textAsHtml || ''),
      text: p.text || '',
      attachments: (p.attachments || [])
        .filter((a) => !(a.related && a.contentId))
        .map((a) => ({ filename: a.filename || '(unnamed)', contentType: a.contentType, size: a.size })),
    };
  });
}

async function verifyImap(imap) {
  return withClient(imap, async (client) => {
    const folder = await findSent(client);
    return { ok: true, folder: folder.name };
  });
}

module.exports = { parseImap, deriveImapHost, listSent, getSentMessage, verifyImap, imapErrText, ImapInputError, analyzeBounce, normId };
