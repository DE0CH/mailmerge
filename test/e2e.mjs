// End-to-end API test against a local fake SMTP server. Run: npm test
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startFakeSmtp } from './fake-smtp.mjs';

const require = createRequire(import.meta.url);
const { createApp } = require('../server.js');

const smtpSrv = await startFakeSmtp({ failFor: ['bounce@example.com'] });
const http = createApp().listen(0, '127.0.0.1');
await new Promise((r) => http.once('listening', r));
const base = `http://127.0.0.1:${http.address().port}`;

const smtp = {
  host: '127.0.0.1', port: smtpSrv.port, security: 'none',
  user: 'tester', pass: 'secret', fromAddress: 'deyao@example.com', fromName: 'Deyao Chen 陈',
};
const template = {
  subject: 'Hello {{name}} ({{ EMAIL }})',
  html: '<h2>Hi {{name}},</h2><p></p><p>Your address is <strong>{{email}}</strong>.</p><ul><li>one</li><li>two</li></ul><p><a href="https://example.com/?u=%7B%7Bemail%7D%7D">link</a></p>',
};

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
}

let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('ok -', name);
}

try {
  await test('healthz', async () => {
    const r = await fetch(base + '/healthz');
    assert.equal(r.status, 200);
    assert.equal(await r.text(), 'ok');
  });

  await test('index + vendored assets are served', async () => {
    for (const p of ['/', '/app.js', '/render.js', '/styles.css', '/vendor/jodit.min.js', '/vendor/jodit.min.css', '/vendor/xlsx.full.min.js']) {
      const r = await fetch(base + p);
      assert.equal(r.status, 200, p);
    }
  });

  await test('verify succeeds with good settings', async () => {
    const r = await call('POST', '/api/verify', { smtp });
    assert.deepEqual(r.data, { ok: true });
  });

  await test('verify reports a bad password', async () => {
    const r = await call('POST', '/api/verify', { smtp: { ...smtp, pass: 'wrong' } });
    assert.equal(r.data.ok, false);
    assert.match(r.data.error, /Invalid credentials|535|auth/i);
  });

  await test('display name is required server side', async () => {
    const r = await call('POST', '/api/verify', { smtp: { ...smtp, fromName: '   ' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /display name/);
    const r2 = await call('POST', '/api/jobs', { smtp: { ...smtp, fromName: '' }, template, recipients: [{ name: 'a', email: 'a@example.com' }] });
    assert.equal(r2.status, 400);
  });

  await test('send-test renders and delivers', async () => {
    const before = smtpSrv.messages.length;
    const r = await call('POST', '/api/send-test', { smtp, template, to: 'me@example.com', sample: { name: 'Jane', email: 'jane@example.com' } });
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
    const m = smtpSrv.messages[before];
    assert.deepEqual(m.envelopeTo, ['me@example.com']);
    assert.equal(m.subject, 'Hello Jane (jane@example.com)');
    assert.equal(m.from[0].name, 'Deyao Chen 陈');
    assert.equal(m.from[0].address, 'deyao@example.com');
    assert.equal(m.user, 'tester');
  });

  await test('job sends one email per recipient with substitution, escaping, html+text, failures', async () => {
    const before = smtpSrv.messages.length;
    const recipients = [
      { key: 'a', name: 'Alice <b>&amp; Co</b>', email: 'alice@example.com' },
      { key: 'b', name: 'Bob', email: 'bounce@example.com' },
      { key: 'c', name: '', email: 'carol@example.com' },
      { key: 'd', name: 'Bad', email: 'not-an-email' },
    ];
    const start = await call('POST', '/api/jobs', { smtp, template, recipients, delayMs: 50 });
    assert.equal(start.status, 201);
    let job;
    for (let i = 0; i < 100; i++) {
      job = (await call('GET', `/api/jobs/${start.data.id}`)).data;
      if (job.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(job.state, 'done');
    assert.equal(job.sent, 2);
    assert.equal(job.failed, 2);
    const byKey = Object.fromEntries(job.items.map((i) => [i.key, i]));
    assert.equal(byKey.a.status, 'sent');
    assert.equal(byKey.b.status, 'failed');
    assert.match(byKey.b.error, /Mailbox unavailable|550/);
    assert.equal(byKey.d.status, 'failed');
    assert.equal(byKey.d.error, 'Invalid email address');

    const sent = smtpSrv.messages.slice(before);
    assert.equal(sent.length, 2);
    const alice = sent.find((m) => m.envelopeTo[0] === 'alice@example.com');
    // From header carries the encoded display name.
    assert.match(alice.fromHeaderRaw, /^From: =\?UTF-8\?.*\?= <deyao@example\.com>$/);
    assert.equal(alice.from[0].name, 'Deyao Chen 陈');
    assert.equal(alice.to[0].name, 'Alice <b>&amp; Co</b>');
    assert.equal(alice.subject, 'Hello Alice <b>&amp; Co</b> (alice@example.com)');
    // HTML part: escaped value, no raw injected tag, URL-encoded placeholder replaced.
    assert.ok(alice.html.includes('Hi Alice &lt;b&gt;&amp;amp; Co&lt;/b&gt;,'), alice.html);
    assert.ok(alice.html.includes('<p style="margin:0"><br></p>'), 'empty line kept: ' + alice.html);
    assert.ok(!alice.html.includes('<b>&amp; Co</b>'));
    assert.ok(alice.html.includes('<strong>alice@example.com</strong>'));
    assert.ok(alice.html.includes('href="https://example.com/?u=alice@example.com"'), alice.html);
    assert.ok(!/\{\{|%7B%7B/.test(alice.html));
    // Text part exists and is readable.
    assert.ok(alice.text.includes('Hi Alice <b>&amp; Co</b>,'), alice.text);
    assert.ok(alice.text.includes('Your address is alice@example.com.'), alice.text);
    assert.ok(/\* one/.test(alice.text), alice.text);
    assert.match(alice.raw, /Content-Type: multipart\/alternative/);
    assert.match(alice.raw, /Content-Type: text\/plain/);
    assert.match(alice.raw, /Content-Type: text\/html/);

    const carol = sent.find((m) => m.envelopeTo[0] === 'carol@example.com');
    assert.equal(carol.subject, 'Hello  (carol@example.com)');
  });

  await test('cancel stops a running job', async () => {
    const recipients = Array.from({ length: 5 }, (_, i) => ({ key: String(i), name: `P${i}`, email: `p${i}@example.com` }));
    const start = await call('POST', '/api/jobs', { smtp, template, recipients, delayMs: 3000 });
    await new Promise((r) => setTimeout(r, 400));
    const c = await call('POST', `/api/jobs/${start.data.id}/cancel`);
    assert.equal(c.status, 200);
    let job;
    for (let i = 0; i < 50; i++) {
      job = (await call('GET', `/api/jobs/${start.data.id}`)).data;
      if (job.state !== 'running') break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(job.state, 'cancelled');
    assert.equal(job.sent, 1);
    assert.equal(job.items.filter((i) => i.status === 'skipped').length, 4);
  });

  await test('unknown job is 404, oversized body is 413', async () => {
    assert.equal((await call('GET', '/api/jobs/nope')).status, 404);
    const big = 'x'.repeat(11 * 1024 * 1024);
    const r = await call('POST', '/api/verify', { smtp, big });
    assert.equal(r.status, 413);
  });

  console.log(`\n${passed} tests passed`);
} finally {
  http.close();
  await smtpSrv.close();
}
