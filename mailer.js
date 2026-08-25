/*
 * mailer.js - sends one email, using nothing but Node's built-in modules.
 * No npm install, no nodemailer.
 *
 * Three modes, chosen in config.json -> mail.mode :
 *   "console" : no email at all, the code is printed in the server window
 *               and appended to otp.log
 *   "gmail"   : Gmail / Google Workspace, using a 16-character App Password
 *   "smtp"    : any other mail server (your company's own)
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

/* ---------- tiny SMTP client ---------- */

function talk(socket, timeoutMs) {
  // reads one complete SMTP reply ("250 OK", or a multi-line "250-..." block)
  return new Promise((resolve, reject) => {
    let buf = '';
    const done = (fn, arg) => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      clearTimeout(timer);
      fn(arg);
    };
    const onData = chunk => {
      buf += chunk.toString('utf8');
      const lines = buf.split(/\r?\n/).filter(l => l.length);
      const last = lines[lines.length - 1];
      if (last && /^\d{3} /.test(last)) {
        done(resolve, { code: parseInt(last.slice(0, 3), 10), text: buf.trim() });
      }
    };
    const onErr = e => done(reject, e);
    const timer = setTimeout(() => done(reject, new Error('Mail server did not answer in time.')), timeoutMs || 20000);
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

function say(socket, line) {
  return new Promise((resolve, reject) => {
    socket.write(line + '\r\n', err => (err ? reject(err) : resolve()));
  });
}

async function expect(socket, wanted, what) {
  const reply = await talk(socket);
  const ok = Array.isArray(wanted) ? wanted.indexOf(reply.code) !== -1 : reply.code === wanted;
  if (!ok) throw new Error(what + ' failed -> ' + reply.text.split(/\r?\n/)[0]);
  return reply;
}

function b64(s) { return Buffer.from(String(s), 'utf8').toString('base64'); }

function headerSafe(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').trim(); }

async function smtpSend(cfg, mail) {
  const host = cfg.host;
  const port = Number(cfg.port);
  const secure = !!cfg.secure;           // true = TLS from the first byte (port 465)
  // company mail servers often use their own certificate; allowSelfSigned lets that through
  const strict = cfg.allowSelfSigned !== true;

  let socket = secure
    ? tls.connect({ host: host, port: port, servername: host, rejectUnauthorized: strict })
    : net.connect({ host: host, port: port });

  socket.setTimeout(25000);
  socket.on('timeout', () => socket.destroy(new Error('Connection to the mail server timed out.')));

  await new Promise((resolve, reject) => {
    socket.once(secure ? 'secureConnect' : 'connect', resolve);
    socket.once('error', reject);
  });

  try {
    await expect(socket, 220, 'Greeting');
    await say(socket, 'EHLO qfl-ext');
    let hello = await expect(socket, 250, 'EHLO');

    // upgrade a plain connection to TLS when the server offers it (port 587)
    if (!secure && /STARTTLS/i.test(hello.text)) {
      await say(socket, 'STARTTLS');
      await expect(socket, 220, 'STARTTLS');
      socket = tls.connect({ socket: socket, servername: host, rejectUnauthorized: strict });
      await new Promise((resolve, reject) => {
        socket.once('secureConnect', resolve);
        socket.once('error', reject);
      });
      await say(socket, 'EHLO qfl-ext');
      hello = await expect(socket, 250, 'EHLO after STARTTLS');
    }

    if (cfg.user) {
      await say(socket, 'AUTH LOGIN');
      await expect(socket, 334, 'AUTH LOGIN');
      await say(socket, b64(cfg.user));
      await expect(socket, 334, 'Username');
      await say(socket, b64(cfg.password));
      await expect(socket, 235, 'Password');
    }

    const fromAddr = (mail.from.match(/<([^>]+)>/) || [null, mail.from])[1];
    await say(socket, 'MAIL FROM:<' + fromAddr + '>');
    await expect(socket, 250, 'MAIL FROM');
    await say(socket, 'RCPT TO:<' + mail.to + '>');
    await expect(socket, [250, 251], 'RCPT TO');
    await say(socket, 'DATA');
    await expect(socket, 354, 'DATA');

    const body = String(mail.text).replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
    const message = [
      'From: ' + headerSafe(mail.from),
      'To: ' + headerSafe(mail.to),
      'Subject: ' + headerSafe(mail.subject),
      'Date: ' + new Date().toUTCString(),
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
      body
    ].join('\r\n');

    await say(socket, message + '\r\n.');
    await expect(socket, 250, 'Sending the message');
    await say(socket, 'QUIT');
  } finally {
    try { socket.end(); } catch (e) {}
  }
}

/* ---------- what the server calls ---------- */

function friendlyError(err) {
  const m = String(err && err.message || err);
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'Cannot find the mail server. Check mail.smtp.host in config.json and your internet connection.';
  if (/ECONNREFUSED/i.test(m)) return 'The mail server refused the connection. Check the port in config.json.';
  if (/timed out|in time/i.test(m)) return 'The mail server did not answer. Your office firewall may be blocking it.';
  if (/Password failed|535/i.test(m)) return 'The mail server rejected the username or password. For Gmail you must use a 16-character App Password, not your normal password.';
  return m;
}

/**
 * send({ mail: <config.mail>, to, subject, text, dir })
 * Always resolves with { mode, ok, error?, shown? } - it never throws,
 * so a mail problem can never crash the phone list.
 */
async function send(opts) {
  const cfg = opts.mail || {};
  const mode = String(cfg.mode || 'console').toLowerCase();

  if (mode === 'console') {
    const stamp = new Date().toISOString();
    const block =
      '\n============================================================\n' +
      '  ' + opts.subject + '\n' +
      '  for: ' + opts.to + '   (' + stamp + ')\n' +
      '------------------------------------------------------------\n' +
      opts.text + '\n' +
      '============================================================\n';
    console.log(block);
    try {
      fs.appendFileSync(path.join(opts.dir || __dirname, 'otp.log'), block, 'utf8');
    } catch (e) {}
    return { mode: 'console', ok: true, shown: true };
  }

  let server;
  if (mode === 'gmail') {
    const g = cfg.gmail || {};
    if (!g.user || !g.appPassword) {
      return { mode: mode, ok: false, error: 'Gmail is selected but mail.gmail.user / mail.gmail.appPassword are empty in config.json.' };
    }
    server = { host: 'smtp.gmail.com', port: 465, secure: true, user: g.user, password: String(g.appPassword).replace(/\s+/g, '') };
  } else if (mode === 'smtp') {
    const s = cfg.smtp || {};
    if (!s.host) return { mode: mode, ok: false, error: 'SMTP is selected but mail.smtp.host is empty in config.json.' };
    server = {
      host: s.host,
      port: Number(s.port) || 587,
      secure: s.secure === true || Number(s.port) === 465,
      user: s.user || '',
      password: s.password || '',
      allowSelfSigned: s.allowSelfSigned === true
    };
  } else {
    return { mode: mode, ok: false, error: 'Unknown mail.mode "' + mode + '". Use console, gmail or smtp.' };
  }

  const from = cfg.from || server.user || 'qfl-ext@localhost';

  try {
    await smtpSend(server, { from: from, to: opts.to, subject: opts.subject, text: opts.text });
    return { mode: mode, ok: true };
  } catch (err) {
    console.log('  [mail] could not send: ' + (err && err.message));
    return { mode: mode, ok: false, error: friendlyError(err) };
  }
}

module.exports = { send: send };
