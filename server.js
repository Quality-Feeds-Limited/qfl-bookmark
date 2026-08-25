/*
 * QFL Extension Finder - simple Node.js server (no frameworks, no npm install)
 *
 * Storage : data.json    (the phone list)
 * Settings: config.json  (admin password - stored encrypted - and email settings)
 *
 * Run:  node server.js      then open http://localhost:6000
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mailer = require('./mailer');

const PORT = process.env.PORT || 6000;
const DIR = __dirname;
const DATA_FILE = path.join(DIR, 'data.json');
const CONFIG_FILE = path.join(DIR, 'config.json');

/* =========================================================
   1. FILE STORAGE
   ========================================================= */

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}

function writeJsonSafely(file, value) {
  // write to a temp file first, then rename - a crash can never leave a half file
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readData() {
  const arr = readJson(DATA_FILE, []);
  return Array.isArray(arr) ? arr : [];
}
function writeData(list) { writeJsonSafely(DATA_FILE, list); }

function readConfig() { return readJson(CONFIG_FILE, {}); }
function writeConfig(cfg) { writeJsonSafely(CONFIG_FILE, cfg); }

function nextId(list) {
  return list.reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1;
}
function clean(v) { return String(v == null ? '' : v).trim(); }

/* =========================================================
   2. PASSWORD ENCRYPTION  (scrypt + random salt)
   -----------------------------------------------------------
   The password itself is never written to config.json. What is
   stored is a scrypt hash of it plus a random salt. A hash cannot
   be turned back into the password, so even someone who opens
   config.json cannot read it.
   ========================================================= */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(plain) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p }).toString('hex');
  return {
    algo: 'scrypt',
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, keylen: SCRYPT.keylen,
    salt: salt,
    hash: hash,
    changedAt: new Date().toISOString()
  };
}

function verifyPassword(plain, stored) {
  if (!stored || !stored.salt || !stored.hash) return false;
  try {
    const test = crypto.scryptSync(String(plain), stored.salt, stored.keylen || 64,
      { N: stored.N || SCRYPT.N, r: stored.r || SCRYPT.r, p: stored.p || SCRYPT.p });
    const real = Buffer.from(stored.hash, 'hex');
    if (real.length !== test.length) return false;
    return crypto.timingSafeEqual(real, test);   // constant time - no timing guesses
  } catch (e) { return false; }
}

function setPassword(plain) {
  const cfg = readConfig();
  cfg.adminPassword = hashPassword(plain);
  delete cfg.adminPin;          // old plain-text field, gone for good
  writeConfig(cfg);
}

// Turn any old plain-text password into an encrypted one, once, at startup.
function migratePassword() {
  const cfg = readConfig();
  const plain =
    (typeof cfg.adminPassword === 'string' && cfg.adminPassword) ? cfg.adminPassword :
    (typeof cfg.adminPin === 'string' && cfg.adminPin) ? cfg.adminPin : null;

  if (plain !== null) {
    cfg.adminPassword = hashPassword(plain);
    delete cfg.adminPin;
    writeConfig(cfg);
    console.log('  [setup] Password encrypted in config.json (the plain text is now removed).');
    return;
  }
  if (!cfg.adminPassword || !cfg.adminPassword.hash) {
    cfg.adminPassword = hashPassword('1234');
    delete cfg.adminPin;
    writeConfig(cfg);
    console.log('  [setup] No password found - default password "1234" created. Please change it.');
  }
}

function passwordProblem(pw) {
  pw = String(pw == null ? '' : pw);
  if (pw.length < 4) return 'Password must be at least 4 characters.';
  if (pw.length > 72) return 'Password is too long (max 72 characters).';
  return null;
}

/* =========================================================
   3. LOGIN SESSIONS
   ========================================================= */

const SESSION_HOURS = 8;
const sessions = {};          // token -> { expires }

function newSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { expires: Date.now() + SESSION_HOURS * 3600 * 1000 };
  return token;
}
function sessionOk(token) {
  const s = sessions[String(token || '')];
  if (!s) return false;
  if (Date.now() > s.expires) { delete sessions[token]; return false; }
  s.expires = Date.now() + SESSION_HOURS * 3600 * 1000;   // keep alive while in use
  return true;
}
function dropAllSessions() { Object.keys(sessions).forEach(k => delete sessions[k]); }

/* =========================================================
   4. FORGOT PASSWORD - one-time code (OTP)
   ========================================================= */

const OTP_MINUTES = 10;
const OTP_MAX_TRIES = 5;
let otp = null;               // { hash, salt, expires, tries, to }

function makeOtp() {
  const code = String(crypto.randomInt(100000, 1000000));   // 6 digits
  const salt = crypto.randomBytes(8).toString('hex');
  otp = {
    salt: salt,
    hash: crypto.createHash('sha256').update(salt + code).digest('hex'),   // the code itself is not kept
    expires: Date.now() + OTP_MINUTES * 60000,
    tries: 0
  };
  return code;
}
function otpOk(given) {
  if (!otp) return { ok: false, error: 'No code has been requested. Click "Forgot password" first.' };
  if (Date.now() > otp.expires) { otp = null; return { ok: false, error: 'That code has expired. Please request a new one.' }; }
  if (otp.tries >= OTP_MAX_TRIES) { otp = null; return { ok: false, error: 'Too many wrong codes. Please request a new one.' }; }
  const test = crypto.createHash('sha256').update(otp.salt + String(given || '').trim()).digest('hex');
  if (test !== otp.hash) { otp.tries++; return { ok: false, error: 'Wrong code. ' + (OTP_MAX_TRIES - otp.tries) + ' tries left.' }; }
  return { ok: true };
}

function maskEmail(addr) {
  addr = String(addr || '');
  const at = addr.indexOf('@');
  if (at < 1) return 'the address in config.json';
  const name = addr.slice(0, at);
  const keep = name.slice(0, Math.min(2, name.length));
  return keep + '*'.repeat(Math.max(3, name.length - keep.length)) + addr.slice(at);
}

/* =========================================================
   5. SMALL HTTP HELPERS
   ========================================================= */

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 1e6) { req.destroy(); reject(new Error('Body too large')); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon'
};

// never let a browser download these
const PRIVATE_FILES = ['config.json', 'config.json.tmp', 'otp.log', 'mailer.js', 'server.js'];

/* friendly page addresses -> the real file on disk.
   "/" is the Bookmarks page, the phone list lives at "/phonebook".
   The plain .html names still work, so old links do not break. */
const PAGES = {
  '/': 'bookmark.html',
  '/bookmark': 'bookmark.html',
  '/phonebook': 'index.html'
};

function serveStatic(res, urlPath) {
  const key = urlPath.length > 1 ? urlPath.replace(/[/]+$/, '') : urlPath;
  const rel = PAGES[key.toLowerCase()] || urlPath.replace(/^\/+/, '');
  const file = path.join(DIR, path.normalize(rel).replace(/^(\.\.[\/\\])+/, ''));
  if (PRIVATE_FILES.indexOf(path.basename(file).toLowerCase()) !== -1) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }
  if (!file.startsWith(DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(file).pipe(res);
}

/* brute-force slowdown: 5 wrong tries from one computer = 60 second wait */
const attempts = {};
function lockedOut(ip) {
  const a = attempts[ip];
  if (!a) return false;
  if (Date.now() - a.at > 60000) { delete attempts[ip]; return false; }
  return a.n >= 5;
}
function noteFail(ip) {
  const a = attempts[ip] || { n: 0, at: Date.now() };
  a.n++; a.at = Date.now();
  attempts[ip] = a;
}

/* =========================================================
   6. RECORD VALIDATION
   ========================================================= */

function validate(body, list, ignoreId) {
  const rec = {
    name: clean(body.name),
    ext: clean(body.ext),
    designation: clean(body.designation),
    department: clean(body.department)
  };
  if (!rec.name) return { error: 'Name is required.' };
  if (!rec.ext) return { error: 'Extension number is required.' };
  if (!/^[0-9/\- ]+$/.test(rec.ext)) return { error: 'Extension may contain only digits, spaces, - and /.' };
  const clash = list.find(r => r.ext === rec.ext && r.id !== ignoreId);
  if (clash) return { warn: 'Extension ' + rec.ext + ' is also used by ' + clash.name + '.', rec: rec };
  return { rec: rec };
}

/* =========================================================
   7. ROUTES
   ========================================================= */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = url.pathname;
  const ip = req.socket.remoteAddress || '?';
  const token = req.headers['x-admin-token'];

  try {

    /* ---- log in ---- */
    if (p === '/api/login' && req.method === 'POST') {
      if (lockedOut(ip)) return sendJson(res, 429, { error: 'Too many wrong tries. Please wait a minute.' });
      const body = await readBody(req);
      if (!verifyPassword(body.password, readConfig().adminPassword)) {
        noteFail(ip);
        return sendJson(res, 401, { error: 'Wrong password.' });
      }
      delete attempts[ip];
      return sendJson(res, 200, { ok: true, token: newSession() });
    }

    /* ---- log out ---- */
    if (p === '/api/logout' && req.method === 'POST') {
      delete sessions[String(token || '')];
      return sendJson(res, 200, { ok: true });
    }

    /* ---- change password (must be logged in) ---- */
    if (p === '/api/change-password' && req.method === 'POST') {
      if (!sessionOk(token)) return sendJson(res, 401, { error: 'Please log in again.' });
      if (lockedOut(ip)) return sendJson(res, 429, { error: 'Too many wrong tries. Please wait a minute.' });
      const body = await readBody(req);
      if (!verifyPassword(body.currentPassword, readConfig().adminPassword)) {
        noteFail(ip);
        return sendJson(res, 401, { error: 'Your current password is not correct.' });
      }
      const bad = passwordProblem(body.newPassword);
      if (bad) return sendJson(res, 400, { error: bad });
      if (String(body.newPassword) === String(body.currentPassword)) {
        return sendJson(res, 400, { error: 'The new password must be different from the old one.' });
      }
      setPassword(body.newPassword);
      dropAllSessions();                       // everybody must log in again
      delete attempts[ip];
      return sendJson(res, 200, { ok: true });
    }

    /* ---- forgot password: send a one-time code ---- */
    if (p === '/api/forgot' && req.method === 'POST') {
      if (lockedOut(ip)) return sendJson(res, 429, { error: 'Too many tries. Please wait a minute.' });
      const cfg = readConfig();
      const to = clean(cfg.recoveryEmail);
      if (!to) {
        return sendJson(res, 400, { error: 'No recovery email is set. Open config.json and fill in "recoveryEmail".' });
      }
      const code = makeOtp();
      const result = await mailer.send({
        mail: cfg.mail,
        dir: DIR,
        to: to,
        subject: 'QFL Extension Finder - password reset code',
        text:
          'Someone asked to reset the admin password of the QFL Extension Finder.\n\n' +
          '    Your one-time code is:   ' + code + '\n\n' +
          'The code is valid for ' + OTP_MINUTES + ' minutes and can be used once.\n' +
          'If this was not you, ignore this message - nothing has changed yet.\n'
      });

      if (!result.ok) {
        otp = null;
        return sendJson(res, 500, { error: 'Could not send the email. ' + (result.error || '') });
      }
      return sendJson(res, 200, {
        ok: true,
        mode: result.mode,
        sentTo: result.mode === 'console' ? null : maskEmail(to),
        note: result.mode === 'console'
          ? 'Mail is set to "console" mode - the code is printed in the server window (and in otp.log).'
          : null,
        minutes: OTP_MINUTES
      });
    }

    /* ---- forgot password: check the code and set a new password ---- */
    if (p === '/api/reset' && req.method === 'POST') {
      if (lockedOut(ip)) return sendJson(res, 429, { error: 'Too many wrong tries. Please wait a minute.' });
      const body = await readBody(req);
      const check = otpOk(body.otp);
      if (!check.ok) { noteFail(ip); return sendJson(res, 401, { error: check.error }); }
      const bad = passwordProblem(body.newPassword);
      if (bad) return sendJson(res, 400, { error: bad });
      setPassword(body.newPassword);
      otp = null;
      dropAllSessions();
      delete attempts[ip];
      return sendJson(res, 200, { ok: true });
    }

    /* ---- the phone list ---- */
    if (p === '/api/contacts' || p.startsWith('/api/contacts/')) {
      const idPart = p.startsWith('/api/contacts/') ? p.slice('/api/contacts/'.length) : '';
      const id = idPart ? Number(idPart) : null;

      // anyone may read; only a logged-in admin may change anything
      if (req.method !== 'GET' && !sessionOk(token)) {
        return sendJson(res, 401, { error: 'Please log in as admin first.' });
      }

      const list = readData();

      if (req.method === 'GET' && !id) return sendJson(res, 200, list);

      if (req.method === 'GET' && id) {
        const found = list.find(r => r.id === id);
        if (!found) return sendJson(res, 404, { error: 'Not found' });
        return sendJson(res, 200, found);
      }

      if (req.method === 'POST' && !id) {
        const body = await readBody(req);
        const v = validate(body, list, null);
        if (v.error) return sendJson(res, 400, { error: v.error });
        const rec = Object.assign({ id: nextId(list) }, v.rec);
        list.push(rec);
        writeData(list);
        return sendJson(res, 201, { record: rec, warn: v.warn || null });
      }

      if ((req.method === 'PUT' || req.method === 'PATCH') && id) {
        const body = await readBody(req);
        const i = list.findIndex(r => r.id === id);
        if (i === -1) return sendJson(res, 404, { error: 'Not found' });
        const v = validate(body, list, id);
        if (v.error) return sendJson(res, 400, { error: v.error });
        list[i] = Object.assign({ id: id }, v.rec);
        writeData(list);
        return sendJson(res, 200, { record: list[i], warn: v.warn || null });
      }

      if (req.method === 'DELETE' && id) {
        const i = list.findIndex(r => r.id === id);
        if (i === -1) return sendJson(res, 404, { error: 'Not found' });
        const removed = list.splice(i, 1)[0];
        writeData(list);
        return sendJson(res, 200, { record: removed });
      }

      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    /* ---- the web page ---- */
    if (req.method === 'GET') return serveStatic(res, p);

    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method not allowed');

  } catch (err) {
    return sendJson(res, 400, { error: err.message });
  }
});

/* =========================================================
   8. START
   ========================================================= */

if (!fs.existsSync(DATA_FILE)) writeData([]);
if (!fs.existsSync(CONFIG_FILE)) writeConfig({});

const bak = path.join(DIR, 'data.backup.json');
if (!fs.existsSync(bak)) fs.copyFileSync(DATA_FILE, bak);

migratePassword();

server.listen(PORT, () => {
  const cfg = readConfig();
  const mode = (cfg.mail && cfg.mail.mode) || 'console';
  console.log('');
  console.log('  QFL Extension Finder is running');
  console.log('  ------------------------------------');
  console.log('  Open:      http://localhost:' + PORT);
  console.log('  Data:      ' + DATA_FILE + '  (' + readData().length + ' records)');
  console.log('  Admin:     click "Admin" on the page');
  console.log('  Password:  encrypted in config.json (scrypt)');
  console.log('  Reset mail: mode "' + mode + '"' +
    (cfg.recoveryEmail ? ' -> ' + cfg.recoveryEmail : ' -> no recoveryEmail set yet'));
  console.log('  Stop:      press Ctrl + C');
  console.log('');
});
