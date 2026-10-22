// A local IMAP server for tests (hoodiecrow-imap, in memory). The mailbox looks like Feishu Mail's:
// a Sent folder named 已发送 in modified UTF-7 (&XfJT0ZAB-) with the \Sent special-use flag, and an INBOX
// holding a Feishu bounce, an RFC 3464 DSN, a postmaster notice, a "delayed" DSN and a human reply.
// Library: startFakeImap({ port }) -> { port, close }.  CLI: node test/fake-imap.mjs <port>
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const hoodiecrow = require('hoodiecrow-imap');

export const USER = 'tester';
export const PASS = 'secret';
const ME = 'Deyao Chen <deyao@example.com>';

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
const encSubj = (s) => `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
const day = (n, h = 9) => new Date(Date.UTC(2026, 9, n, h, 0, 0));
const rfcDate = (d) => d.toUTCString().replace('GMT', '+0000');

function sentMsg({ id, to, subject, date, html, text }) {
  const raw = [
    `From: ${ME}`,
    `To: ${to}`,
    `Subject: ${encSubj(subject)}`,
    `Date: ${rfcDate(date)}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="alt"',
    '',
    '--alt',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(text || 'Hello'),
    '--alt',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64(html || `<p>${text || 'Hello'}</p>`),
    '--alt--',
    '',
  ].join('\r\n');
  return { raw, internaldate: date, flags: ['\\Seen'] };
}

export const FIXTURE = {
  ok: 'm-ok@example.com',
  feishu: 'm-feishu@example.com',
  dsn: 'm-dsn@example.com',
  notice: 'm-notice@example.com',
  delayed: 'm-delayed@example.com',
  replied: 'm-replied@example.com',
  fillers: 55,
};

export function buildStorage() {
  const sent = [];
  // older mail first: 55 fillers (so the first page of 50 leaves some for "Load more")
  for (let i = 1; i <= FIXTURE.fillers; i++) {
    sent.push(sentMsg({ id: `filler-${i}@example.com`, to: `Person ${i} <p${i}@example.com>`, subject: `Newsletter ${i}`, date: new Date(Date.UTC(2026, 8, 1, 0, i)) }));
  }
  sent.push(sentMsg({ id: FIXTURE.ok, to: 'Alice <alice@example.com>', subject: 'Hello Alice', date: day(15) }));
  sent.push(sentMsg({ id: FIXTURE.feishu, to: 'Nobody <nobody@bounce.example>', subject: '季度通訊', date: day(16) }));
  sent.push(sentMsg({ id: FIXTURE.dsn, to: 'ghost@example.org', subject: 'Invitation', date: day(17) }));
  sent.push(sentMsg({ id: FIXTURE.notice, to: 'old@example.net', subject: 'Reminder', date: day(18) }));
  sent.push(sentMsg({ id: FIXTURE.delayed, to: 'slow@example.com', subject: 'Slow server', date: day(19) }));
  sent.push(sentMsg({
    id: FIXTURE.replied, to: 'Bob <bob@example.com>', subject: 'Script test', date: day(20),
    html: '<h2 id="h">Hi Bob</h2><p>Body <b>bold</b> <a href="https://example.com/">link</a></p><script>document.getElementById("h").textContent="SCRIPT RAN"</script>',
    text: 'Hi Bob',
  }));

  const inbox = [];
  // Feishu's bounce: In-Reply-To without angle brackets, multipart/alternative, "Email delivery failed <addr>"
  inbox.push({
    internaldate: day(16, 10),
    raw: [
      'From: mailer-daemon@feishu.cn',
      `To: ${ME}`,
      `Subject: ${encSubj('邮件退信')}`,
      `Date: ${rfcDate(day(16, 10))}`,
      'Message-ID: <bounce-1@feishu.cn>',
      `In-Reply-To: ${FIXTURE.feishu}`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/alternative; boundary="b1"',
      '',
      '--b1',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64('Email delivery failed <nobody@bounce.example>\n'),
      '--b1',
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      b64('<div>Email delivery failed &lt;nobody@bounce.example&gt;</div>'),
      '--b1--',
      '',
    ].join('\r\n'),
  });
  // RFC 3464 DSN with text/rfc822-headers
  inbox.push({
    internaldate: day(17, 10),
    raw: [
      'From: Mail Delivery System <MAILER-DAEMON@mx.example.org>',
      `To: ${ME}`,
      'Subject: Undelivered Mail Returned to Sender',
      `Date: ${rfcDate(day(17, 10))}`,
      'Message-ID: <dsn-1@mx.example.org>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="r1"',
      '',
      '--r1',
      'Content-Type: text/plain; charset=us-ascii',
      '',
      'This is the mail system. Your message could not be delivered.',
      '',
      '--r1',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example.org',
      '',
      'Final-Recipient: rfc822; ghost@example.org',
      'Original-Recipient: rfc822;ghost@example.org',
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp; 550 5.1.1 <ghost@example.org>: Recipient address',
      ' rejected: User unknown',
      '',
      '--r1',
      'Content-Type: text/rfc822-headers',
      '',
      `From: ${ME}`,
      'To: ghost@example.org',
      'Subject: Invitation',
      `Message-ID: <${FIXTURE.dsn}>`,
      `References: <${FIXTURE.ok}>`,
      '',
      '--r1--',
      '',
    ].join('\r\n'),
  });
  // A postmaster notice that only quotes the original in its text
  inbox.push({
    internaldate: day(18, 10),
    raw: [
      'From: postmaster@example.net',
      `To: ${ME}`,
      'Subject: Delivery failure',
      `Date: ${rfcDate(day(18, 10))}`,
      'Message-ID: <notice-1@example.net>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Your message to old@example.net could not be delivered: mailbox does not exist.',
      '',
      '----- Original message -----',
      `Message-ID: <${FIXTURE.notice}>`,
      'Subject: Reminder',
      '',
    ].join('\r\n'),
  });
  // A "delayed" DSN: not a bounce
  inbox.push({
    internaldate: day(19, 10),
    raw: [
      'From: MAILER-DAEMON@mx.example.com',
      `To: ${ME}`,
      'Subject: Delivery Status Notification (Delay)',
      `Date: ${rfcDate(day(19, 10))}`,
      'Message-ID: <dsn-2@mx.example.com>',
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="r2"',
      '',
      '--r2',
      'Content-Type: text/plain',
      '',
      'Delivery is delayed. We will keep trying.',
      '',
      '--r2',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns; mx.example.com',
      '',
      'Final-Recipient: rfc822; slow@example.com',
      'Action: delayed',
      'Status: 4.4.1',
      '',
      '--r2',
      'Content-Type: text/rfc822-headers',
      '',
      `Message-ID: <${FIXTURE.delayed}>`,
      '',
      '--r2--',
      '',
    ].join('\r\n'),
  });
  // A human reply: In-Reply-To the original, but not a bounce
  inbox.push({
    internaldate: day(20, 12),
    raw: [
      'From: Bob <bob@example.com>',
      `To: ${ME}`,
      'Subject: Re: Script test',
      `Date: ${rfcDate(day(20, 12))}`,
      'Message-ID: <reply-1@example.com>',
      `In-Reply-To: <${FIXTURE.replied}>`,
      'Content-Type: text/plain',
      '',
      'Thanks, got it. The delivery failed earlier but this one worked.',
      '',
    ].join('\r\n'),
  });

  return {
    INBOX: { messages: inbox },
    '': {
      separator: '/',
      folders: {
        '&XfJT0ZAB-': { 'special-use': '\\Sent', messages: sent },
        Drafts: { 'special-use': '\\Drafts' },
      },
    },
  };
}

export function startFakeImap({ port = 0 } = {}) {
  const server = hoodiecrow({
    plugins: ['ID', 'ENABLE', 'NAMESPACE', 'UIDPLUS', 'SPECIAL-USE', 'UNSELECT'],
    users: { [USER]: { password: PASS } },
    storage: buildStorage(),
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ port: server.server ? server.server.address().port : server.address().port, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const s = await startFakeImap({ port: Number(process.argv[2] || 1143) });
  console.log(`fake IMAP on 127.0.0.1:${s.port}`);
}
