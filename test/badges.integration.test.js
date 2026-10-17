'use strict';

/**
 * Profile badges (#5632): the badge list and who may change it, earned
 * badges reaching their thresholds, badges that come and go with a role,
 * hand-given badges and the rank rules on them, icon uploads, and a member
 * hiding a badge on their own card.
 *
 *   node --test test/badges.integration.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createHarness, wait, privacyToolsAvailable } = require('./socketServerHarness');
const { sniffImage } = require('../src/routes/badges');
const { earns, daysSince } = require('../src/badges');

const PORT = 3448;
const h = createHarness(PORT, 'badges');

test.before(() => h.start());
test.after(() => h.stop());

// A 1x1 transparent PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

async function uploadIcon(token, bytes, type, name = 'icon.png') {
  const form = new FormData();
  form.append('icon', new Blob([bytes], { type }), name);
  const res = await fetch(`http://localhost:${PORT}/api/upload-badge-icon`, {
    method: 'POST', body: form, headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function profileBadges(sock, userId) {
  const got = h.next(sock, 'user-profile', (p) => p && p.id === userId);
  sock.emit('get-user-profile', { userId });
  const profile = await got;
  assert.ok(profile, 'profile arrived');
  return profile.badges || [];
}

const names = (list) => list.map((b) => b.name).sort();

test('profile badges', async (t) => {
  const admin = await h.register('admin');
  const mod = await h.register('mod');
  const bob = await h.register('bob');
  const carol = await h.register('carol');
  const A = await h.connect(admin.token);
  const M = await h.connect(mod.token);
  const B = await h.connect(bob.token);
  const C = await h.connect(carol.token);
  const db = new Database(path.join(h.dataDir, 'haven.db'));
  db.pragma('busy_timeout = 5000');
  t.after(() => db.close());

  const roles = (await h.ask(A, 'get-roles', {})).roles;
  const modRole = roles.find((r) => r.name === 'Mod');
  for (const id of [mod.id, carol.id]) {
    assert.ok((await h.ask(A, 'assign-role', { userId: id, roleId: modRole.id })).success);
  }
  assert.ok((await h.ask(A, 'set-user-server-perm', { userId: mod.id, permission: 'manage_badges', allowed: true })).success);
  await wait(100);

  await t.test('only the admin and Manage Badges holders see and change the list', async () => {
    assert.ok((await h.ask(B, 'get-badges', {})).error, 'a member cannot list badges');
    assert.ok((await h.ask(B, 'create-badge', { name: 'Mine', iconType: 'emoji', icon: '🏅', kind: 'manual' })).error, 'or make one');
    assert.ok((await h.ask(C, 'get-badges', {})).error, 'a mod without Manage Badges cannot either');

    const list = await h.ask(A, 'get-badges', {});
    assert.ok(list.ok);
    assert.ok(list.badges.length >= 5, 'the default badges are there');
    assert.ok(list.badges.every((b) => b.enabled === false), 'and all start switched off');
    assert.ok((await h.ask(M, 'get-badges', {})).ok, 'a Manage Badges holder can list them');
  });

  let helperBadge;
  await t.test('definitions are checked, made, changed and deleted', async () => {
    for (const bad of [
      { name: '', iconType: 'emoji', icon: '🏅', kind: 'manual' },
      { name: 'X', iconType: 'emoji', icon: '<b>', kind: 'manual' },
      { name: 'X', iconType: 'emoji', icon: '123', kind: 'manual' },
      { name: 'X', iconType: 'image', icon: '/uploads/../haven.db', kind: 'manual' },
      { name: 'X', iconType: 'builtin', icon: 'nope', kind: 'manual' },
      { name: 'X', iconType: 'emoji', icon: '🏅', kind: 'messages', threshold: 0 },
      { name: 'X', iconType: 'emoji', icon: '🏅', kind: 'role', roleId: 999999 },
      { name: 'X', iconType: 'emoji', icon: '🏅', kind: 'purchased' },
    ]) {
      const r = await h.ask(A, 'create-badge', bad);
      assert.ok(r && r.error, `refused: ${JSON.stringify(bad)}`);
    }
    const made = await h.ask(A, 'create-badge', { name: 'Temp <b>x</b>', description: 'short', iconType: 'builtin', icon: 'trophy', kind: 'manual' });
    assert.ok(made.ok && made.badgeId, JSON.stringify(made));
    const stored = made.badges.find((b) => b.id === made.badgeId);
    assert.strictEqual(stored.name, 'Temp bx/b', 'markup brackets are dropped');
    const changed = await h.ask(A, 'update-badge', { badgeId: made.badgeId, name: 'Renamed', enabled: false });
    assert.ok(changed.ok);
    assert.strictEqual(changed.badges.find((b) => b.id === made.badgeId).name, 'Renamed');
    assert.ok((await h.ask(B, 'update-badge', { badgeId: made.badgeId, name: 'Hijack' })).error, 'a member cannot change it');
    assert.ok((await h.ask(B, 'delete-badge', { badgeId: made.badgeId })).error, 'or delete it');
    const gone = await h.ask(A, 'delete-badge', { badgeId: made.badgeId });
    assert.ok(gone.ok && !gone.badges.some((b) => b.id === made.badgeId));

    // A mod ties badges only to roles below their own.
    const high = await h.ask(M, 'create-badge', { name: 'Staff', iconType: 'emoji', icon: '🛡️', kind: 'role', roleId: modRole.id });
    assert.match(high.error || '', /below your own/);
    const helper = await h.ask(A, 'create-role', { name: 'Helper', level: 10, permissions: [] });
    helperBadge = await h.ask(M, 'create-badge', { name: 'Helper', iconType: 'emoji', icon: '🤝', kind: 'role', roleId: helper.roleId });
    assert.ok(helperBadge.ok, JSON.stringify(helperBadge));
    helperBadge.roleId = helper.roleId;
    const adminOnes = await h.ask(A, 'create-badge', { name: 'Mod team', iconType: 'emoji', icon: '🛡️', kind: 'role', roleId: modRole.id });
    assert.ok(adminOnes.ok, 'the admin can tie a badge to any role');
    assert.match((await h.ask(M, 'update-badge', { badgeId: adminOnes.badgeId, name: 'Mine now' })).error || '', /below your own/);
    assert.match((await h.ask(M, 'delete-badge', { badgeId: adminOnes.badgeId })).error || '', /below your own/);
  });

  // A server channel everyone posts in.
  const made = h.next(A, 'channels-list', (chs) => Array.isArray(chs) && chs.some((c) => c.name === 'general'));
  A.emit('create-channel', { name: 'general' });
  const code = (await made).find((c) => c.name === 'general').code;
  for (const s of [B, C]) { s.emit('join-channel', { code }); }
  await wait(200);
  for (const s of [A, B, C]) { s.emit('enter-channel', { code }); }
  await wait(200);

  await t.test('earned badges follow messages, forum likes and account age', async () => {
    const msg = await h.ask(A, 'create-badge', { name: 'Two posts', iconType: 'emoji', icon: '💬', kind: 'messages', threshold: 2 });
    const likes = await h.ask(A, 'create-badge', { name: 'Liked', iconType: 'builtin', icon: 'heart', kind: 'forum_likes', threshold: 1 });
    const age = await h.ask(A, 'create-badge', { name: 'Old timer', iconType: 'builtin', icon: 'shield', kind: 'account_age', threshold: 30 });
    assert.ok(msg.ok && likes.ok && age.ok);

    B.emit('send-message', { code, content: 'one' });
    await wait(250);
    assert.ok(!names(await profileBadges(A, bob.id)).includes('Two posts'), 'one message is not two');
    B.emit('send-message', { code, content: 'two' });
    await wait(250);
    assert.ok(names(await profileBadges(A, bob.id)).includes('Two posts'), 'two messages earn it');

    // A DM does not count.
    const dm = db.prepare("INSERT INTO channels (name, code, created_by, is_dm) VALUES ('dm', 'dd00dd00', ?, 1)").run(carol.id).lastInsertRowid;
    db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'private')").run(dm, carol.id);
    db.prepare("INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, 'private')").run(dm, carol.id);
    assert.ok(!names(await profileBadges(A, carol.id)).includes('Two posts'), 'DM messages are not counted');

    // Deleting a message takes it off the count.
    const last = db.prepare("SELECT id FROM messages WHERE user_id = ? AND content = 'two'").get(bob.id);
    B.emit('delete-message', { messageId: last.id, channelCode: code });
    await wait(250);
    assert.ok(!names(await profileBadges(A, bob.id)).includes('Two posts'), 'a deleted message no longer counts');

    // Likes from others count; liking your own topic does not.
    const first = db.prepare("SELECT id FROM messages WHERE user_id = ? AND content = 'one'").get(bob.id);
    db.prepare('INSERT INTO forum_votes (message_id, user_id, value) VALUES (?, ?, 1)').run(first.id, bob.id);
    assert.ok(!names(await profileBadges(A, bob.id)).includes('Liked'), 'a self-like is not counted');
    db.prepare('INSERT INTO forum_votes (message_id, user_id, value) VALUES (?, ?, 1)').run(first.id, carol.id);
    assert.ok(names(await profileBadges(A, bob.id)).includes('Liked'), 'a like from someone else counts');
    db.prepare('UPDATE forum_votes SET value = -1 WHERE message_id = ? AND user_id = ?').run(first.id, carol.id);
    assert.ok(!names(await profileBadges(A, bob.id)).includes('Liked'), 'turning it into a dislike takes it off');

    assert.ok(!names(await profileBadges(A, bob.id)).includes('Old timer'), 'a new account is not 30 days old');
    db.prepare("UPDATE users SET created_at = datetime('now', '-31 days') WHERE id = ?").run(bob.id);
    assert.ok(names(await profileBadges(A, bob.id)).includes('Old timer'), 'a 31 day old account is');

    // Switched off, nobody shows it.
    await h.ask(A, 'update-badge', { badgeId: age.badgeId, enabled: false });
    assert.ok(!names(await profileBadges(A, bob.id)).includes('Old timer'), 'a switched off badge is hidden');
  });

  await t.test('role badges come and go with the role', async () => {
    assert.ok(!names(await profileBadges(A, bob.id)).includes('Helper'));
    assert.ok((await h.ask(A, 'assign-role', { userId: bob.id, roleId: helperBadge.roleId })).success);
    const shown = await profileBadges(C, bob.id);
    const badge = shown.find((b) => b.name === 'Helper');
    assert.ok(badge, 'holding the role shows the badge');
    assert.strictEqual(badge.roleName, 'Helper');
    assert.ok((await h.ask(A, 'revoke-role', { userId: bob.id, roleId: helperBadge.roleId })).success);
    assert.ok(!names(await profileBadges(C, bob.id)).includes('Helper'), 'losing the role takes it away');
    assert.ok(names(await profileBadges(A, mod.id)).includes('Mod team'), 'the Mod role badge shows on a mod');
    assert.ok(!names(await profileBadges(A, bob.id)).includes('Mod team'));
  });

  await t.test('hand-given badges follow the rank rules and are audited', async () => {
    const given = await h.ask(A, 'create-badge', { name: 'Helpful', iconType: 'emoji', icon: '⭐', kind: 'manual' });
    const id = given.badgeId;

    assert.ok((await h.ask(B, 'grant-badge', { userId: carol.id, badgeId: id })).error, 'a member cannot give badges');
    assert.ok((await h.ask(C, 'grant-badge', { userId: bob.id, badgeId: id })).error, 'nor can a mod without Manage Badges');
    assert.match((await h.ask(M, 'grant-badge', { userId: mod.id, badgeId: id })).error || '', /ranked below/, 'not to yourself');
    assert.match((await h.ask(M, 'grant-badge', { userId: carol.id, badgeId: id })).error || '', /ranked below/, 'not to an equal');
    assert.match((await h.ask(M, 'grant-badge', { userId: admin.id, badgeId: id })).error || '', /ranked below/, 'not to the admin');
    assert.ok((await h.ask(M, 'get-member-badges', { userId: admin.id })).error, 'nor list what the admin has');
    const msgBadge = (await h.ask(A, 'get-badges', {})).badges.find((b) => b.name === 'Two posts');
    assert.ok((await h.ask(A, 'grant-badge', { userId: bob.id, badgeId: msgBadge.id })).error, 'earned badges are not handed out');

    assert.ok((await h.ask(M, 'grant-badge', { userId: bob.id, badgeId: id })).ok, 'a mod gives it to a member');
    assert.ok(names(await profileBadges(C, bob.id)).includes('Helpful'));
    const listed = await h.ask(M, 'get-member-badges', { userId: bob.id });
    assert.ok(listed.badges.find((b) => b.id === id).held);
    const holders = await h.ask(A, 'get-badge-holders', { badgeId: id });
    assert.deepStrictEqual(holders.holders.map((x) => [x.name, x.grantedBy, x.canRevoke]), [['bob', 'mod', true]]);

    // The admin gives one to carol; the mod cannot take it back from an equal.
    assert.ok((await h.ask(A, 'grant-badge', { userId: carol.id, badgeId: id })).ok);
    assert.match((await h.ask(M, 'revoke-badge', { userId: carol.id, badgeId: id })).error || '', /ranked below/);
    assert.ok(names(await profileBadges(B, carol.id)).includes('Helpful'));

    assert.ok((await h.ask(M, 'revoke-badge', { userId: bob.id, badgeId: id })).ok, 'whoever can give can take back');
    assert.ok(!names(await profileBadges(C, bob.id)).includes('Helpful'));

    const log = db.prepare("SELECT action, actor_username, target_name, details FROM audit_log WHERE action LIKE 'badge_%' ORDER BY id").all();
    const grants = log.filter((r) => r.action === 'badge_grant' || r.action === 'badge_revoke').map((r) => [r.action, r.actor_username, r.target_name]);
    assert.deepStrictEqual(grants, [['badge_grant', 'mod', 'bob'], ['badge_grant', 'admin', 'carol'], ['badge_revoke', 'mod', 'bob']]);
    assert.ok(log.some((r) => r.action === 'badge_create') && log.some((r) => r.action === 'badge_delete'), 'definition changes are logged too');
  });

  await t.test('no two badges share an icon', async () => {
    const list = (await h.ask(A, 'get-badges', {})).badges;
    const keys = list.map((b) => b.iconKey);
    assert.ok(keys.every(Boolean), 'every badge has an icon key');
    assert.strictEqual(new Set(keys).size, keys.length, 'and they are all different');

    const taken = /Another badge already uses this icon/;
    // A built-in a default badge shows.
    assert.match((await h.ask(A, 'create-badge', { name: 'Seedling', iconType: 'builtin', icon: 'sprout', kind: 'manual' })).error || '', taken);
    // The same emoji, with or without its emoji-style marker.
    assert.match((await h.ask(A, 'create-badge', { name: 'Guard', iconType: 'emoji', icon: '\u{1F6E1}\uFE0F', kind: 'manual' })).error || '', taken);
    assert.match((await h.ask(A, 'create-badge', { name: 'Guard', iconType: 'emoji', icon: '\u{1F6E1}', kind: 'manual' })).error || '', taken);
    // Changing a badge to an icon another one shows.
    const liked = list.find((b) => b.name === 'Liked');
    const moved = await h.ask(A, 'update-badge', { badgeId: liked.id, iconType: 'builtin', icon: 'star' });
    assert.match(moved.error || '', /Regular/, 'the message names the badge using it');
    // Keeping its own icon, or moving to a free one, is fine.
    assert.ok((await h.ask(A, 'update-badge', { badgeId: liked.id, name: 'Well liked' })).ok);
    const free = await h.ask(A, 'update-badge', { badgeId: liked.id, iconType: 'emoji', icon: '\u{1F44D}' });
    assert.ok(free.ok, JSON.stringify(free));
    assert.strictEqual(free.badges.find((b) => b.id === liked.id).iconKey, 'emoji:\u{1F44D}');
    // Once the heart is free again, another badge may take it.
    const heart = await h.ask(A, 'create-badge', { name: 'Kind', iconType: 'builtin', icon: 'heart', kind: 'manual' });
    assert.ok(heart.ok, JSON.stringify(heart));
    assert.ok((await h.ask(A, 'delete-badge', { badgeId: heart.badgeId })).ok);
  });

  await t.test('members hide their own badges', async () => {
    const helpful = (await h.ask(A, 'get-badges', {})).badges.find((b) => b.name === 'Helpful');
    assert.ok((await h.ask(C, 'set-badge-hidden', { badgeId: helpful.id, hidden: true })).ok);
    assert.ok(!names(await profileBadges(B, carol.id)).includes('Helpful'), 'others no longer see it');
    const own = (await profileBadges(C, carol.id)).find((b) => b.id === helpful.id);
    assert.ok(own && own.hidden === true, 'the owner still sees it, marked hidden');
    assert.ok((await h.ask(C, 'set-badge-hidden', { badgeId: helpful.id, hidden: 'yes' })).error, 'only true or false');
    assert.ok((await h.ask(C, 'set-badge-hidden', { badgeId: helpful.id, hidden: false })).ok);
    assert.ok(names(await profileBadges(B, carol.id)).includes('Helpful'), 'shown again');
    assert.ok(!('hidden' in (await profileBadges(B, carol.id))[0]), 'others are not told what is hidden');
  });

  await t.test('icon uploads are checked', async () => {
    assert.strictEqual((await uploadIcon(null, PNG, 'image/png')).status, 401);
    assert.strictEqual((await uploadIcon(bob.token, PNG, 'image/png')).status, 403);
    assert.strictEqual((await uploadIcon(admin.token, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'image/svg+xml', 'x.svg')).status, 400, 'no SVG');
    const fake = await uploadIcon(admin.token, Buffer.from('not really a png at all'), 'image/png');
    assert.strictEqual(fake.status, 400, 'bytes must match the type');
    const big = await uploadIcon(admin.token, Buffer.concat([PNG, Buffer.alloc(300 * 1024)]), 'image/png');
    assert.strictEqual(big.status, 400, 'too large');
    assert.match(big.body.error || '', /256 KB/);

    if (!privacyToolsAvailable()) {
      const refused = await uploadIcon(mod.token, PNG, 'image/png');
      assert.strictEqual(refused.status, 400, 'pictures are refused while their location data cannot be removed');
      assert.match(refused.body.error || '', /misconfiguration/);
      return;
    }

    const ok = await uploadIcon(mod.token, PNG, 'image/png');
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.match(ok.body.path, /^\/uploads\/badges\/\d+-[a-f0-9]{16}\.png$/);
    const pic = await h.ask(M, 'create-badge', { name: 'Pictured', iconType: 'image', icon: ok.body.path, kind: 'manual' });
    assert.ok(pic.ok, JSON.stringify(pic));
    const file = path.join(h.dataDir, 'uploads', 'badges', path.basename(ok.body.path));
    assert.ok(require('node:fs').existsSync(file));

    // The same picture uploaded again is a new file with the same key, and
    // a second badge cannot show it.
    const again = await uploadIcon(admin.token, PNG, 'image/png');
    assert.strictEqual(again.status, 200);
    assert.notStrictEqual(again.body.path, ok.body.path);
    assert.strictEqual(again.body.iconKey, ok.body.iconKey);
    assert.strictEqual(pic.badges.find((b) => b.id === pic.badgeId).iconKey, ok.body.iconKey);
    const twin = await h.ask(A, 'create-badge', { name: 'Twin', iconType: 'image', icon: again.body.path, kind: 'manual' });
    assert.match(twin.error || '', /Another badge already uses this icon \(Pictured\)/);
    const missing = await h.ask(A, 'create-badge', { name: 'Gone', iconType: 'image', icon: '/uploads/badges/1700000000000-0123456789abcdef.png', kind: 'manual' });
    assert.match(missing.error || '', /missing/, 'a picture that is not on disk is refused');
    assert.ok((await h.ask(M, 'delete-badge', { badgeId: pic.badgeId })).ok);
    await wait(100);
    assert.ok(!require('node:fs').existsSync(file), 'deleting the badge removes its unused icon');
  });
});

test('threshold and image checks on their own', () => {
  assert.strictEqual(earns({ kind: 'messages', threshold: 100 }, { messages: 99 }), false);
  assert.strictEqual(earns({ kind: 'messages', threshold: 100 }, { messages: 100 }), true);
  assert.strictEqual(earns({ kind: 'forum_likes', threshold: 5 }, { forumLikes: 6 }), true);
  assert.strictEqual(earns({ kind: 'account_age', threshold: 365 }, { ageDays: 364 }), false);
  assert.strictEqual(earns({ kind: 'manual', threshold: 1 }, { messages: 5 }), false);
  const now = Date.parse('2026-10-16T12:00:00Z');
  assert.strictEqual(daysSince('2025-10-16 12:00:00', now), 365);
  assert.strictEqual(daysSince(null, now), 0);
  assert.strictEqual(sniffImage(Buffer.from('GIF89a......')), 'image/gif');
  assert.strictEqual(sniffImage(Buffer.from([0xFF, 0xD8, 0xFF, 0xE0])), 'image/jpeg');
  assert.strictEqual(sniffImage(Buffer.from('RIFF....WEBP')), 'image/webp');
  assert.strictEqual(sniffImage(Buffer.from('<svg>')), null);
});

// The owner's rule: no two default badges look alike, and neither do the
// built-in icons. Each built-in has its own background colour, and the
// defaults are far enough apart in hue to tell at a glance.
test('default badges and built-in icons are all different', () => {
  const fs = require('node:fs');
  const { DEFAULT_BADGES, BUILTIN_ICONS } = require('../src/badges');
  const icons = DEFAULT_BADGES.map((b) => b.icon);
  assert.strictEqual(new Set(icons).size, icons.length, 'no two default badges share an icon');
  for (const icon of icons) assert.ok(BUILTIN_ICONS.includes(icon), `${icon} is a built-in icon`);

  const dir = path.join(__dirname, '..', 'public', 'img', 'badges');
  const fill = {};
  const drawn = new Set();
  for (const name of BUILTIN_ICONS) {
    const svg = fs.readFileSync(path.join(dir, `${name}.svg`), 'utf8');
    const m = svg.match(/<circle cx="32" cy="32" r="30" fill="#([0-9a-f]{6})"\/>/);
    assert.ok(m, `${name}.svg has a background colour`);
    fill[name] = m[1];
    drawn.add(svg.slice(m.index + m[0].length).replaceAll(m[1], ''));
  }
  assert.strictEqual(new Set(Object.values(fill)).size, BUILTIN_ICONS.length, 'every built-in has its own colour');
  assert.strictEqual(drawn.size, BUILTIN_ICONS.length, 'and its own picture');

  const hue = (hex) => {
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
    if (!d) return 0;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  };
  for (let i = 0; i < icons.length; i++) {
    for (let j = i + 1; j < icons.length; j++) {
      const a = hue(fill[icons[i]]), b = hue(fill[icons[j]]);
      const apart = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
      assert.ok(apart >= 30, `${icons[i]} and ${icons[j]} are ${Math.round(apart)} degrees apart in colour`);
    }
  }
});
