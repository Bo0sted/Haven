/**
 * Birthdays.
 *
 * Setting a birthday locks it for 30 days. Unsetting hides it at any time but
 * keeps the lock. Other people only ever see the month and day.
 *
 * Boots a server on a scratch port and data dir:
 *   node --test test/birthday.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const Database = require('better-sqlite3');
const { io } = require('socket.io-client');

const PORT = 3441;
const BASE = `http://localhost:${PORT}`;
const DATA = path.join(os.tmpdir(), `haven-birthday-${Date.now()}`);

let server;

const post = (p, body) => new Promise((res, rej) => {
  const d = JSON.stringify(body);
  const r = http.request({ host: 'localhost', port: PORT, path: p, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
    (x) => { let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => { try { res(JSON.parse(b)); } catch { res({ raw: b }); } }); });
  r.on('error', rej); r.write(d); r.end();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function connect(token) {
  const s = io(BASE, { auth: { token }, transports: ['websocket'], forceNew: true });
  return new Promise((res, rej) => { s.on('connect', () => res(s)); s.on('connect_error', rej); });
}
function next(sock, event, ms = 4000) {
  return new Promise((res) => {
    const t = setTimeout(() => { sock.off(event, h); res(null); }, ms);
    const h = (data) => { clearTimeout(t); sock.off(event, h); res(data); };
    sock.on(event, h);
  });
}
// Send a birthday and report what came back: the update, or the error text.
function setBirthday(sock, birthday) {
  return new Promise((res) => {
    const done = (result) => {
      clearTimeout(t);
      sock.off('birthday-updated', onUpdated);
      sock.off('error-msg', onError);
      res(result);
    };
    const onUpdated = (updated) => done({ updated });
    const onError = (error) => done({ error });
    const t = setTimeout(() => done({}), 4000);
    sock.on('birthday-updated', onUpdated);
    sock.on('error-msg', onError);
    sock.emit('set-birthday', { birthday });
  });
}
async function profileOf(sock, userId) {
  const reply = next(sock, 'user-profile');
  sock.emit('get-user-profile', { userId });
  return reply;
}

test.before(async () => {
  fs.mkdirSync(DATA, { recursive: true });
  server = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(PORT), HAVEN_DATA_DIR: DATA, ADMIN_USERNAME: 'admin', FORCE_HTTP: 'true' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      await new Promise((res, rej) => http.get(`${BASE}/api/health`, (r) => (r.statusCode === 200 ? res() : rej())).on('error', rej));
      return;
    } catch { await wait(500); }
  }
  throw new Error('server did not start');
});
test.after(() => { server?.kill(); try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {} });

test('a birthday is locked for 30 days, unset keeps the lock, and the year shows only when unhidden', async () => {
  await post('/api/auth/register', { username: 'admin', password: 'birthday123', eulaVersion: '2.0', ageVerified: true });
  const ann = await post('/api/auth/register', { username: 'ann', password: 'birthday123', eulaVersion: '2.0', ageVerified: true });
  const bob = await post('/api/auth/register', { username: 'bob', password: 'birthday123', eulaVersion: '2.0', ageVerified: true });
  assert.ok(ann.token && bob.token, 'both registered');
  const A = await connect(ann.token);
  const B = await connect(bob.token);

  for (const bad of ['2001-02-30', '1899-12-31', '3000-01-01', '01-02', 42]) {
    assert.ok((await setBirthday(A, bad)).error, `${bad} is refused`);
  }

  const set = await setBirthday(A, '2000-06-15');
  assert.equal(set.updated?.birthday, '2000-06-15');
  assert.ok(set.updated.birthdaySetAt, 'the lock starts');

  const seen = await profileOf(B, ann.user.id);
  assert.equal(seen.birthday, '06-15', 'the year stays private');

  assert.match((await setBirthday(A, '2000-06-16')).error || '', /30 days/, 'a change inside the lock is refused');

  const shown = await new Promise((res) => {
    A.once('birthday-updated', res);
    A.emit('set-birthday', { birthday: '2000-06-15', hideYear: false });
  });
  assert.equal(shown.birthdaySetAt, set.updated.birthdaySetAt, 'Hide birth year is not part of the lock');
  assert.equal((await profileOf(B, ann.user.id)).birthday, '2000-06-15', 'the year shows once unhidden');

  const unset = await setBirthday(A, null);
  assert.equal(unset.updated?.birthday, null, 'unset is allowed while locked');
  assert.equal(unset.updated.birthdaySetAt, set.updated.birthdaySetAt, 'unset keeps the lock');
  assert.equal((await profileOf(B, ann.user.id)).birthday, null, 'an unset birthday is hidden');
  assert.match((await setBirthday(A, '2000-06-15')).error || '', /30 days/, 'unset does not end the lock');

  const A2 = await connect(ann.token);
  const session = await next(A2, 'session-info');
  assert.equal(session.birthday, null);
  assert.equal(session.birthdaySetAt, set.updated.birthdaySetAt, 'the owner gets the lock on connect');
  A2.close();

  const db = new Database(path.join(DATA, 'haven.db'));
  db.prepare("UPDATE users SET birthday_set_at = ? WHERE username = 'ann'")
    .run(new Date(Date.now() - 31 * 86400000).toISOString());
  db.close();
  assert.equal((await setBirthday(A, '2000-07-01')).updated?.birthday, '2000-07-01', 'the lock ends after 30 days');

  A.close();
  B.close();
});
