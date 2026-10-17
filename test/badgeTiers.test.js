'use strict';

// Earned badges of one kind are tiers (#5800): a card shows only the highest
// of each kind earned, and hiding that one does not bring a lower one back.

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const badges = require('../src/badges');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE roles (id INTEGER PRIMARY KEY, name TEXT, level INTEGER, scope TEXT);
    CREATE TABLE user_roles (id INTEGER PRIMARY KEY, user_id INTEGER, role_id INTEGER, channel_id INTEGER);
    CREATE TABLE channels (id INTEGER PRIMARY KEY, is_dm INTEGER DEFAULT 0, is_forum INTEGER DEFAULT 0);
    CREATE TABLE messages (id INTEGER PRIMARY KEY, channel_id INTEGER, user_id INTEGER, thread_id INTEGER, content TEXT, is_webhook INTEGER DEFAULT 0, type TEXT DEFAULT 'user');
    CREATE TABLE forum_votes (message_id INTEGER, user_id INTEGER, value INTEGER);
  `);
  badges.migrateBadges(db);
  // The stock badges arrive switched off until an admin turns them on.
  db.prepare('UPDATE badges SET enabled = 1').run();
  return db;
}

const DAY = 86400000;
const names = (list) => list.map(b => b.name).sort();

test('only the highest earned badge of each kind shows', () => {
  const db = makeDb();
  const now = Date.now();
  const joined = new Date(now - 400 * DAY).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO users (id, username, created_at) VALUES (1, ?, ?)').run('old', joined);
  db.prepare('INSERT INTO badge_stats (user_id, messages, forum_likes) VALUES (1, 1500, 0)').run();
  // A hand-given badge always shows alongside.
  const manual = db.prepare("INSERT INTO badges (name, icon_type, icon, kind, enabled, position) VALUES ('Helper', 'builtin', 'heart', 'manual', 1, 99)").run().lastInsertRowid;
  db.prepare('INSERT INTO user_badges (badge_id, user_id) VALUES (?, 1)').run(manual);

  const seen = badges.badgesForProfile(db, 1, 2, now);
  assert.deepEqual(names(seen), ['Helper', 'One year', 'Regular'], 'one year, not one month or six months; Regular, not Chatty');

  // Hiding the top account-age badge hides that kind, it does not fall back.
  const oneYear = seen.find(b => b.name === 'One year').id;
  db.prepare('INSERT INTO badge_hidden (user_id, badge_id) VALUES (1, ?)').run(oneYear);
  assert.deepEqual(names(badges.badgesForProfile(db, 1, 2, now)), ['Helper', 'Regular']);
  // Their own card still lists it, marked hidden, so they can show it again.
  const own = badges.badgesForProfile(db, 1, 1, now);
  assert.equal(own.find(b => b.name === 'One year').hidden, true);
  assert.ok(!own.some(b => b.name === 'Six months'));
});

test('a newer member shows the tier they have reached', () => {
  const db = makeDb();
  const now = Date.now();
  const joined = new Date(now - 40 * DAY).toISOString().replace('T', ' ').slice(0, 19);
  db.prepare('INSERT INTO users (id, username, created_at) VALUES (1, ?, ?)').run('new', joined);
  db.prepare('INSERT INTO badge_stats (user_id, messages, forum_likes) VALUES (1, 150, 0)').run();
  assert.deepEqual(names(badges.badgesForProfile(db, 1, 2, now)), ['Chatty', 'One month']);
});
