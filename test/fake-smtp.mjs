// A tiny SMTP catcher for tests. Accepts any login, parses each message with mailparser.
// Library: startFakeSmtp({ port }) -> { port, messages, close }.
// CLI: node test/fake-smtp.mjs <port> <outDir>  — writes each message as <n>.json into outDir.
import { SMTPServer } from 'smtp-server';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function startFakeSmtp({ port = 0, outDir = null, failFor = [] } = {}) {
  const messages = [];
  const server = new SMTPServer({
    secure: false,
    authOptional: true,
    allowInsecureAuth: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onAuth(auth, session, cb) {
      if (auth.password === 'wrong') return cb(new Error('Invalid credentials'));
      cb(null, { user: auth.username });
    },
    onRcptTo(addr, session, cb) {
      if (failFor.includes(addr.address)) return cb(new Error('550 Mailbox unavailable'));
      cb();
    },
    onData(stream, session, cb) {
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', async () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = await simpleParser(raw);
        const msg = {
          raw,
          envelopeTo: session.envelope.rcptTo.map((r) => r.address),
          user: session.user || null,
          from: parsed.from && parsed.from.value,
          to: parsed.to && parsed.to.value,
          subject: parsed.subject,
          html: parsed.html || null,
          text: parsed.text || null,
          fromHeaderRaw: (raw.match(/^From: .*$/m) || [''])[0],
        };
        messages.push(msg);
        if (outDir) fs.writeFileSync(path.join(outDir, `${messages.length}.json`), JSON.stringify(msg, null, 2));
        cb();
      });
    },
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ port: server.server.address().port, messages, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 2525);
  const outDir = process.argv[3] || null;
  if (outDir) fs.mkdirSync(outDir, { recursive: true });
  const s = await startFakeSmtp({ port, outDir, failFor: ['bounce@example.com'] });
  console.log(`fake SMTP on 127.0.0.1:${s.port}`);
}
