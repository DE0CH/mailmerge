'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const nodemailer = require('nodemailer');
const { convert: htmlToText } = require('html-to-text');
const R = require('./public/render.js');

const MAX_RECIPIENTS = 5000;
const MAX_DELAY_MS = 60_000;
const JOB_TTL_MS = 6 * 60 * 60 * 1000; // finished jobs are forgotten after 6 h

class BadRequest extends Error {}

// ---------- validation ----------

function str(v, max = 1000) {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function parseSmtp(raw) {
  if (!raw || typeof raw !== 'object') throw new BadRequest('SMTP settings are missing.');
  const host = str(raw.host, 255).trim();
  const port = Number(raw.port);
  const security = str(raw.security, 20);
  const user = str(raw.user, 320).trim();
  const pass = str(raw.pass, 1000);
  const fromAddress = str(raw.fromAddress, 320).trim();
  const fromName = str(raw.fromName, 200).trim();

  if (!host) throw new BadRequest('SMTP host is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new BadRequest('SMTP port must be 1–65535.');
  if (!['ssl', 'starttls', 'none'].includes(security)) throw new BadRequest('Security must be SSL/TLS, STARTTLS or none.');
  if (!R.isEmail(fromAddress)) throw new BadRequest('The From address is not a valid email address.');
  if (!fromName) throw new BadRequest('The sender display name is required.');
  if (/[\r\n]/.test(fromName)) throw new BadRequest('The sender display name cannot contain line breaks.');

  return { host, port, security, user, pass, fromAddress, fromName };
}

function parseTemplate(raw) {
  if (!raw || typeof raw !== 'object') throw new BadRequest('The template is missing.');
  const subject = str(raw.subject, 2000);
  const html = str(raw.html, 5_000_000);
  if (!subject.trim()) throw new BadRequest('The subject is empty.');
  if (!html.trim()) throw new BadRequest('The body is empty.');
  return { subject, html };
}

function parseRecipient(raw) {
  const email = str(raw && raw.email, 320).trim();
  const name = str(raw && raw.name, 200).replace(/[\r\n]+/g, ' ').trim();
  return { name, email };
}

// ---------- mail ----------

function makeTransport(smtp, { pool = false } = {}) {
  const opts = {
    host: smtp.host,
    port: smtp.port,
    secure: smtp.security === 'ssl',
    requireTLS: smtp.security === 'starttls',
    ignoreTLS: smtp.security === 'none',
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  };
  if (smtp.user || smtp.pass) opts.auth = { user: smtp.user, pass: smtp.pass };
  if (pool) Object.assign(opts, { pool: true, maxConnections: 1, maxMessages: 100 });
  return nodemailer.createTransport(opts);
}

function buildMessage(smtp, template, recipient) {
  const bodyHtml = R.renderBodyHtml(template.html, recipient);
  return {
    from: { name: smtp.fromName, address: smtp.fromAddress },
    to: recipient.name ? { name: recipient.name, address: recipient.email } : recipient.email,
    subject: R.renderSubject(template.subject, recipient),
    html: R.wrapDocument(bodyHtml),
    text: htmlToText(R.mailFriendly(bodyHtml), {
      wordwrap: 78,
      selectors: [
        { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
        { selector: 'p', options: { leadingLineBreaks: 1, trailingLineBreaks: 1 } },
        { selector: 'h1', options: { uppercase: false } },
        { selector: 'h2', options: { uppercase: false } },
        { selector: 'h3', options: { uppercase: false } },
      ],
    }).replace(/\u00a0/g, ' '), // the editor stores typed trailing spaces as &nbsp;
  };
}

function errText(err) {
  const msg = (err && (err.response || err.message)) || String(err);
  return String(msg).slice(0, 500);
}

// ---------- jobs ----------

const jobs = new Map();

function publicJob(job) {
  return {
    id: job.id,
    state: job.state, // running | done | cancelled | error
    total: job.items.length,
    done: job.items.filter((i) => i.status === 'sent' || i.status === 'failed').length,
    sent: job.items.filter((i) => i.status === 'sent').length,
    failed: job.items.filter((i) => i.status === 'failed').length,
    error: job.error || null,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    items: job.items.map(({ key, email, status, error }) => ({ key, email, status, error: error || null })),
  };
}

function sleep(ms, job) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    job.wake = () => { clearTimeout(t); resolve(); };
  });
}

async function runJob(job, smtp, template, delayMs) {
  const transport = makeTransport(smtp, { pool: true });
  try {
    for (let i = 0; i < job.items.length; i++) {
      if (job.cancelled) break;
      const item = job.items[i];
      if (!R.isEmail(item.email)) {
        item.status = 'failed';
        item.error = 'Invalid email address';
        continue;
      }
      item.status = 'sending';
      try {
        const info = await transport.sendMail(buildMessage(smtp, template, item));
        item.status = 'sent';
        item.messageId = info.messageId;
      } catch (err) {
        item.status = 'failed';
        item.error = errText(err);
      }
      if (i < job.items.length - 1 && delayMs > 0 && !job.cancelled) await sleep(delayMs, job);
    }
    for (const item of job.items) if (item.status === 'pending') item.status = 'skipped';
    job.state = job.cancelled ? 'cancelled' : 'done';
  } catch (err) {
    job.state = 'error';
    job.error = errText(err);
  } finally {
    transport.close();
    job.finishedAt = new Date().toISOString();
    setTimeout(() => jobs.delete(job.id), JOB_TTL_MS).unref();
  }
}

// ---------- app ----------

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10mb' }));

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });

  app.get('/healthz', (req, res) => res.type('text').send('ok'));

  app.post('/api/verify', async (req, res, next) => {
    try {
      const smtp = parseSmtp(req.body && req.body.smtp);
      const transport = makeTransport(smtp);
      try {
        await transport.verify();
        res.json({ ok: true });
      } catch (err) {
        res.json({ ok: false, error: errText(err) });
      } finally {
        transport.close();
      }
    } catch (err) { next(err); }
  });

  app.post('/api/send-test', async (req, res, next) => {
    try {
      const body = req.body || {};
      const smtp = parseSmtp(body.smtp);
      const template = parseTemplate(body.template);
      const to = str(body.to, 320).trim();
      if (!R.isEmail(to)) throw new BadRequest('The test address is not a valid email address.');
      const sample = parseRecipient(body.sample || {});
      const msg = buildMessage(smtp, template, sample);
      msg.to = to;
      const transport = makeTransport(smtp);
      try {
        const info = await transport.sendMail(msg);
        res.json({ ok: true, messageId: info.messageId });
      } catch (err) {
        res.json({ ok: false, error: errText(err) });
      } finally {
        transport.close();
      }
    } catch (err) { next(err); }
  });

  app.post('/api/jobs', (req, res, next) => {
    try {
      const body = req.body || {};
      const smtp = parseSmtp(body.smtp);
      const template = parseTemplate(body.template);
      if (!Array.isArray(body.recipients) || body.recipients.length === 0) throw new BadRequest('No recipients selected.');
      if (body.recipients.length > MAX_RECIPIENTS) throw new BadRequest(`At most ${MAX_RECIPIENTS} recipients per run.`);
      let delayMs = Number(body.delayMs);
      if (!Number.isFinite(delayMs) || delayMs < 0) delayMs = 1000;
      delayMs = Math.min(Math.round(delayMs), MAX_DELAY_MS);

      const items = body.recipients.map((r, i) => {
        const { name, email } = parseRecipient(r);
        return { key: str(r && r.key, 100) || String(i), name, email, status: 'pending' };
      });
      const job = { id: crypto.randomUUID(), state: 'running', items, startedAt: new Date().toISOString(), cancelled: false };
      jobs.set(job.id, job);
      runJob(job, smtp, template, delayMs);
      res.status(201).json(publicJob(job));
    } catch (err) { next(err); }
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found (the server may have restarted).' });
    res.json(publicJob(job));
  });

  app.post('/api/jobs/:id/cancel', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found.' });
    if (job.state === 'running') {
      job.cancelled = true;
      if (job.wake) job.wake();
    }
    res.json(publicJob(job));
  });

  // Cloudflare in front caches .js/.css (and its zone browser TTL overrides our headers), so the
  // page links each asset as file?v=<content hash>: a deploy changes the URL. The page itself is no-store.
  const PUBLIC = path.join(__dirname, 'public');
  const indexHtml = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace(
    /(src|href)="((?:vendor\/)?[\w.-]+\.(?:js|css))"/g,
    (m, attr, file) => {
      const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(PUBLIC, file))).digest('hex').slice(0, 12);
      return `${attr}="${file}?v=${hash}"`;
    },
  );
  app.get(['/', '/index.html'], (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(indexHtml);
  });
  app.use(express.static(PUBLIC, { index: false }));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
    if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large (10 MB max).' });
    if (err && err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    console.error(err);
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}

module.exports = { createApp, buildMessage };

if (require.main === module) {
  const port = Number(process.env.PORT) || 8080;
  const server = createApp().listen(port, () => console.log(`mailmerge listening on :${port}`));
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
