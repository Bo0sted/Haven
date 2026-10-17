'use strict';

/**
 * Each soundboard sound's volume (#5804): set by an admin or anyone with
 * Manage Soundboard, 0 to 100 percent, sent with the sound list, and gone
 * again at 100 or when the sound is renamed away or deleted.
 *
 *   node --test test/soundVolume.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness } = require('./socketServerHarness');

const PORT = 3498;
const BASE = `http://127.0.0.1:${PORT}`;
const h = createHarness(PORT, 'sound-volume');

test.before(() => h.start());
test.after(() => h.stop());

const call = async (method, path, token, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

test('a sound\'s soundboard volume', async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const sounds = async (token) => (await call('GET', '/api/sounds', token)).body.sounds;
  const name = (await sounds(admin.token))[0].name;
  const path = `/api/sounds/${encodeURIComponent(name)}/volume`;

  assert.strictEqual((await call('PUT', path, bob.token, { volume: 30 })).status, 403, 'a member without Manage Soundboard is refused');
  assert.strictEqual((await call('PUT', path, admin.token, { volume: 150 })).status, 400, 'above 100 is refused');
  assert.strictEqual((await call('PUT', path, admin.token, { volume: 33.5 })).status, 400, 'whole numbers only');
  assert.strictEqual((await call('PUT', '/api/sounds/no%20such%20sound/volume', admin.token, { volume: 40 })).status, 404);

  assert.strictEqual((await call('PUT', path, admin.token, { volume: 40 })).status, 200);
  const turnedDown = (await sounds(bob.token)).find(s => s.name === name);
  assert.strictEqual(turnedDown.volume, 40, 'everyone gets the level with the sound');

  assert.strictEqual((await call('PUT', path, admin.token, { volume: 100 })).status, 200);
  const full = (await sounds(bob.token)).find(s => s.name === name);
  assert.ok(!('volume' in full), 'full volume sends nothing extra');
});
