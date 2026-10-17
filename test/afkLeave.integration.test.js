'use strict';

/**
 * AFK disconnect (#5801): a channel can disconnect people who are idle in
 * voice instead of moving them to an AFK sub-channel, with no sub-channel
 * needed. The sweep runs every 30 seconds and the shortest timeout is a
 * minute, so this test takes about a minute and a half.
 *
 *   node --test test/afkLeave.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, wait } = require('./socketServerHarness');

const h = createHarness(3499, 'afk-leave');

test.before(() => h.start());
test.after(() => h.stop());

test('an idle member is disconnected from voice', { timeout: 150000 }, async () => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);

  const created = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'hangout'));
  A.emit('create-channel', { name: 'hangout' });
  const room = (await created).find((c) => c.name === 'hangout');

  // A channel with no sub-channels can still disconnect idle people.
  const saved = h.next(A, 'channels-list', (chs) => chs.some((c) => c.code === room.code && c.afk_sub_code === '__leave__' && c.afk_timeout_minutes === 1));
  A.emit('set-channel-afk', { code: room.code, subCode: '__leave__', timeout: 1 });
  assert.ok(await saved, 'the setting is stored');

  const B = await h.connect(bob.token);
  B.emit('join-channel', { code: room.code });
  await wait(300);
  const inVoice = h.next(B, 'voice-existing-users', (d) => d && d.channelCode === room.code);
  B.emit('voice-join', { code: room.code });
  assert.ok(await inVoice, 'bob joined the call');

  const left = await h.next(B, 'voice-afk-leave', (d) => d && d.channelCode === room.code, 120000);
  assert.strictEqual(left.minutes, 1);
  // He is out of the call: nobody is left in it.
  const roster = await h.next(A, 'voice-users-update', (d) => d && d.channelCode === room.code, 5000).catch(() => null);
  if (roster) assert.ok(!(roster.users || []).some((u) => u.id === bob.id), 'bob is no longer in the call');

  A.disconnect();
  B.disconnect();
});
