# mailmerge

A small self-hosted mail merge web app. Write one email, fill in `{{name}}` and `{{email}}` for
each recipient, and send it one message at a time through your own SMTP server.

- **Sender**: SMTP host, port, security (SSL/TLS, STARTTLS or none), username, password, From
  address and a **required** display name, so mail always arrives as `Name <address>`.
  "Test connection" runs an SMTP login check.
- **Template**: subject plus a WYSIWYG body (Quill: headings, bold/italic/underline, colour,
  lists, links). `{{name}}` / `{{email}}` work in both; values filled into the body are
  HTML-escaped. A plain-text part is generated from the HTML. Live preview per recipient.
- **Recipients**: editable list (add, edit inline, delete, select/deselect), invalid-address and
  duplicate warnings. Import `.xlsx` / `.xls` / `.csv` (Name, Email; header row optional),
  replacing or appending; "Download template" gives a ready-made `.xlsx`.
- **Send**: one email per selected recipient, in order, with a configurable pause; per-recipient
  progress (sent / failed with the server's error), summary and cancel. "Send a test" sends one
  rendered email to any address.
- **Sync**: export everything as one settings key, import it in another browser.

Everything you enter (including the SMTP password) is stored only in your browser's
`localStorage`. The server stores nothing: the browser sends the settings with each request, and
send jobs live in server memory only (forgotten 6 h after they finish, or on restart).

There is no login. Run it somewhere private (e.g. behind Cloudflare Access or a VPN): anyone who
can reach it can use it to send mail with whatever SMTP credentials they supply.

## The settings key

> This is the key to sync your settings. Save it somewhere safe — anyone who has it can log in
> to the mailbox and send email as you.

The key is base64 of UTF-8 JSON (`{"app":"mailmerge","v":1,...}`). It is **not encrypted**; it
contains the SMTP password in plain text once decoded.

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
| POST | `/api/verify` | `{smtp}` | `{ok, error?}` |
| POST | `/api/send-test` | `{smtp, template, to, sample:{name,email}}` | `{ok, error?}` |
| POST | `/api/jobs` | `{smtp, template:{subject,html}, recipients:[{key,name,email}], delayMs}` | job |
| GET | `/api/jobs/:id` | | job: `{state, total, done, sent, failed, items:[{key,email,status,error}]}` |
| POST | `/api/jobs/:id/cancel` | | job |

`smtp` = `{host, port, security: "ssl"|"starttls"|"none", user, pass, fromAddress, fromName}`.

## Tests

```sh
npm test                                   # API end to end against an in-process fake SMTP server
node test/fake-smtp.mjs 2526 /tmp/mm-mail &   # browser test: fake SMTP writing to /tmp/mm-mail
PORT=8099 node server.js &
MAIL_DIR=/tmp/mm-mail python3 test/ui_test.py shots/   # Playwright; screenshots at 390 and 1400 px
```

## Third-party code

`public/vendor/` holds Quill 2.0.3 (BSD-3-Clause) and SheetJS CE 0.20.3 (Apache-2.0), served
locally; see `public/vendor/VENDORED.txt`.

## License

MIT © Deyao Chen
