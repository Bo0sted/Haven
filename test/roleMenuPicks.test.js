'use strict';

/**
 * Role menu pick limits (#5800): the rule on its own, then a real server
 * through both ways of picking, the buttons and the reactions.
 *
 *   node --test test/roleMenuPicks.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const picks = require('../src/roleMenuPicks');
const { createHarness, wait } = require('./socketServerHarness');

test('the pick rule', () => {
  assert.deepStrictEqual(picks.planPick({ held: [1, 2], roleId: 3, maxPicks: 0 }), { drop: [] }, 'no limit');
  assert.deepStrictEqual(picks.planPick({ held: [1], roleId: 2, maxPicks: 1 }), { drop: [1] }, 'one: swap');
  assert.deepStrictEqual(picks.planPick({ held: [1], roleId: 2, maxPicks: 2 }), { drop: [] }, 'room left');
  assert.ok(picks.planPick({ held: [1, 2], roleId: 3, maxPicks: 2 }).error, 'two of two: refused');
  assert.deepStrictEqual(picks.planPick({ held: [1, 2], roleId: 2, maxPicks: 2 }), { drop: [] }, 'one already held does not count against itself');
  assert.strictEqual(picks.cleanMaxPicks(1, 3), 1);
  assert.strictEqual(picks.cleanMaxPicks(3, 3), 0, 'as many as the menu has is no limit');
  assert.strictEqual(picks.cleanMaxPicks(-2, 3), 0);
  assert.strictEqual(picks.cleanMaxPicks('2', 3), 2);
  assert.strictEqual(picks.cleanMaxPicks(1.5, 3), 0);
  assert.strictEqual(picks.maxPicksOf({ data: '{"roles":[],"maxPicks":2}' }), 2);
  assert.strictEqual(picks.maxPicksOf({ data: 'not json' }), 0);
});

const h = createHarness(3500, 'role-menu-picks');
test.before(() => h.start());
test.after(() => h.stop());

test('a menu limits picks through buttons and reactions', async (t) => {
  const admin = await h.register('admin');
  const bob = await h.register('bob');
  const A = await h.connect(admin.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const made = [];
  for (const name of ['Fire', 'Water', 'Plant']) {
    const r = await h.ask(A, 'create-role', { name, level: 2, permissions: [] });
    assert.ok(r.success, JSON.stringify(r));
    made.push(r.roleId);
  }
  const [fire, water, plant] = made;
  A.emit('create-channel', { name: 'roles' });
  let ch;
  for (let i = 0; i < 30 && !ch; i++) { ch = db.prepare('SELECT id, code FROM channels WHERE name = ?').get('roles'); if (!ch) await wait(100); }
  const B = await h.connect(bob.token);
  B.emit('join-channel', { code: ch.code });
  await wait(300);

  const holds = () => db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? AND channel_id IS NULL').all(bob.id).map(r => r.role_id).filter(id => made.includes(id)).sort();
  const roles = [{ roleId: fire, emoji: '🔥' }, { roleId: water, emoji: '💧' }, { roleId: plant, emoji: '🌱' }];

  // Pick one: a second pick swaps.
  const one = await h.ask(A, 'create-role-menu', { code: ch.code, title: 'Element', roles, maxPicks: 1 });
  assert.ok(one.success, JSON.stringify(one));
  assert.strictEqual(JSON.parse(db.prepare('SELECT data FROM role_menus WHERE message_id = ?').get(one.messageId).data).maxPicks, 1);
  assert.ok((await h.ask(B, 'toggle-self-role', { messageId: one.messageId, roleId: fire })).success);
  assert.ok((await h.ask(B, 'toggle-self-role', { messageId: one.messageId, roleId: water })).success);
  assert.deepStrictEqual(holds(), [water].sort(), 'water replaced fire');
  const chips = db.prepare('SELECT emoji FROM reactions WHERE message_id = ? AND user_id = ?').all(one.messageId, bob.id).map(r => r.emoji);
  assert.deepStrictEqual(chips, ['💧'], 'the chips follow');

  // The same through a reaction.
  B.emit('add-reaction', { messageId: one.messageId, emoji: '🌱' });
  await wait(500);
  assert.deepStrictEqual(holds(), [plant], 'a reaction swaps too');

  // Pick up to two: a third is refused, by button and by reaction.
  B.emit('toggle-self-role', { messageId: one.messageId, roleId: plant, held: false });
  await wait(200);
  const two = await h.ask(A, 'create-role-menu', { code: ch.code, title: 'Two', roles, maxPicks: 2 });
  assert.ok((await h.ask(B, 'toggle-self-role', { messageId: two.messageId, roleId: fire })).success);
  assert.ok((await h.ask(B, 'toggle-self-role', { messageId: two.messageId, roleId: water })).success);
  const third = await h.ask(B, 'toggle-self-role', { messageId: two.messageId, roleId: plant });
  assert.ok(third.error, 'the third pick is refused');
  const refused = h.next(B, 'error-msg', (m) => /up to 2/.test(String(m)));
  B.emit('add-reaction', { messageId: two.messageId, emoji: '🌱' });
  assert.ok(await refused, 'a reaction past the limit is refused with a note');
  await wait(300);
  assert.deepStrictEqual(holds(), [fire, water].sort());
  assert.ok(!db.prepare('SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?').get(two.messageId, bob.id, '🌱'), 'the refused reaction is taken back');

  // Dropping is always allowed.
  assert.ok((await h.ask(B, 'toggle-self-role', { messageId: two.messageId, roleId: fire })).success);
  assert.deepStrictEqual(holds(), [water]);

  // The editor reads the limit back.
  const back = await h.ask(A, 'get-role-menu', { messageId: two.messageId });
  assert.strictEqual(back.maxPicks, 2);

  A.disconnect();
  B.disconnect();
});
