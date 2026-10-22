# mailmerge

A small self-hosted mail merge web app. Write one email, fill in `{{name}}` and `{{email}}` for
each recipient, send it one message at a time through your own SMTP server, and see what the
mailbox has sent and what bounced.

- **Sender**: the mail account is set **only by importing a settings key** (Sync tab), so nobody
  has to type account details. The page shows it read-only (From name and address, SMTP and IMAP
  server, username). "Test connection" checks the SMTP login and the IMAP login (and that a Sent
  folder exists). With no key imported the page says so and sending is off.
- **Template**: subject plus a body edited in [Jodit](https://github.com/xdan/jodit), with a
  Visual tab (WYSIWYG) and an HTML tab (raw source). A full HTML document pasted into the HTML
  tab is sent as it is. `{{name}}` / `{{email}}` work in both; values filled into the body are
  HTML-escaped. A plain-text part is generated from the HTML. Live preview per recipient.
- **Recipients**: editable list (add, edit inline, delete, select/deselect), invalid-address and
  duplicate warnings. Import `.xlsx` / `.xls` / `.csv` (Name, Email; header row optional),
  replacing or appending; "Download template" gives a ready-made `.xlsx`.
- **Send**: one email per selected recipient, in order, with a configurable pause; per-recipient
  progress (sent / failed with the server's error), summary and cancel. "Send a test" sends one
  rendered email to any address.
- **Sent**: the mailbox's whole Sent folder over IMAP (also mail sent outside this app), newest
  first, 50 at a time with "Load more". Each message shows date, To, subject and **Bounced** (with
  the address and reason) or **Not bounced**; tapping one shows it, its HTML in a sandboxed iframe
  with scripts off. The Sent folder is the one with the `\Sent` special-use flag (Feishu Mail's is
  named `&XfJT0ZAB-`, 已发送), bounces are read from INBOX (see below).
- **Sync**: export everything as one settings key, import it in another browser. Importing
  replaces what the key holds (mail account, template, recipients) and keeps the rest.

Everything you enter (including the SMTP password) is stored only in your browser's
`localStorage`. The server stores nothing: the browser sends the settings with each request, and
send jobs live in server memory only (forgotten 6 h after they finish, or on restart).

There is no login. Run it somewhere private (e.g. behind Cloudflare Access or a VPN): anyone who
can reach it can use it to send mail with whatever SMTP credentials they supply.

## The settings key

> This is the key to sync your settings. Save it somewhere safe — anyone who has it can log in
> to the mailbox and send email as you.

The key is base64 of UTF-8 JSON. It is **not encrypted**; it contains the passwords in plain text
once decoded.

```json
{
  "app": "mailmerge", "v": 1,
  "smtp": {"host": "smtp.feishu.cn", "port": 587, "security": "starttls",
           "user": "me@example.com", "pass": "…", "fromAddress": "me@example.com", "fromName": "Me"},
  "imap": {"host": "imap.feishu.cn", "port": 993, "security": "ssl", "user": "me@example.com", "pass": "…"},
  "template": {"subject": "…", "html": "…"},
  "recipients": [{"name": "…", "email": "…", "selected": true}],
  "prefs": {"delayMs": 1000, "testTo": "…"}
}
```

Every part is optional; a key for staff usually holds only `smtp` (and `imap`). `imap` is only
needed when the IMAP server is not the SMTP one's: without it the app uses host `smtp.X` → `imap.X`
(any other host as it is), port 993, SSL/TLS, and the SMTP username and password. Inside `imap`,
missing `user`/`pass` also fall back to the SMTP ones.

## Bounces

For each message on a Sent page, the app reads INBOX (since two days before the oldest message on
the page), keeps the messages that look like bounce notices (from `mailer-daemon`/`postmaster`, or a
bounce-like subject such as `Undelivered`, `Delivery failure`, `邮件退信`) and matches them in code
(not with the server's `SEARCH HEADER`, which returns wrong results outside the Sent folder on Feishu):

- **Feishu Mail**: from `mailer-daemon@feishu.cn`, subject `邮件退信`, `In-Reply-To:` the original
  Message-ID without angle brackets, text `Email delivery failed <address>`.
- **RFC 3464 DSNs** (`multipart/report`): the failed recipients and `Status`/`Diagnostic-Code` from
  `message/delivery-status`; the original Message-ID from the attached `message/rfc822` or
  `text/rfc822-headers`. A DSN whose recipients are all `delayed`/`delivered` is not a bounce.
- **Other notices**: the original Message-ID found anywhere in the notice.

## Run locally

Node.js 22 or newer:

```sh
npm ci
npm start            # http://localhost:8080  (PORT=... to change)
```

## Docker

```sh
docker run --rm -p 8080:8080 ghcr.io/de0ch/mailmerge:latest
```

The image (built by `.github/workflows/image.yml` on every push to `main`, tagged `latest` and
`sha-<short>`) runs as the non-root `node` user, listens on `$PORT` (default 8080) and answers
`GET /healthz` with `ok`. JSON request bodies are capped at 10 MB.

## API

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| POST | `/api/verify` | `{smtp, imap?, checkImap?}` | `{ok, error?, imap?:{ok, error?, folder, host, port}}` |
| POST | `/api/send-test` | `{smtp, template, to, sample:{name,email}}` | `{ok, error?}` |
| POST | `/api/jobs` | `{smtp, template:{subject,html}, recipients:[{key,name,email}], delayMs}` | job |
| GET | `/api/jobs/:id` | | job: `{state, total, done, sent, failed, items:[{key,email,status,error}]}` |
| POST | `/api/jobs/:id/cancel` | | job |
| POST | `/api/sent` | `{smtp, imap?, offset, limit}` (limit ≤ 200, default 50) | `{ok, folder, total, offset, hasMore, items:[{uid, date, subject, to, cc, messageId, size, status: "bounced"\|"not-bounced", bounces:[{address, reason, date}]}]}` or `{ok:false, error}` |
| POST | `/api/sent/message` | `{smtp, imap?, uid}` | `{ok, uid, subject, from, to, cc, bcc, date, messageId, html, text, attachments:[{filename, contentType, size}]}` |

`smtp` = `{host, port, security: "ssl"|"starttls"|"none", user, pass, fromAddress, fromName}`;
`imap` = `{host, port, security, user, pass}` (see the settings key). The server keeps no IMAP
connection: each call logs in, reads and logs out. Outgoing ports used: the SMTP port (587) and
the IMAP port (993).

## Tests

```sh
npm test                                   # API end to end against in-process fake SMTP and IMAP servers
node test/fake-smtp.mjs 2526 /tmp/mm-mail &   # browser test: fake SMTP writing to /tmp/mm-mail
node test/fake-imap.mjs 2143 &                # fake IMAP (hoodiecrow-imap): Feishu-like Sent folder + bounces
PORT=8099 node server.js &
MAIL_DIR=/tmp/mm-mail python3 test/ui_test.py shots/   # Playwright; screenshots at 390 and 1400 px
```

## Third-party code

`public/vendor/` holds Jodit 4.15.14 (MIT) and SheetJS CE 0.20.3 (Apache-2.0), served
locally; see `public/vendor/VENDORED.txt`.

## License

MIT © Deyao Chen
