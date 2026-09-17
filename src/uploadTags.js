'use strict';

// ── Upload tagging (attachment tags) ────────────────────────────────────────
// A GLOBAL, server-wide tag vocabulary that users attach to file/image uploads
// at send time. Distinct from the per-channel forum-topic tags (channels.
// forum_tags + messages.tags JSON) — those are a different feature that happens
// to share the word "tag".
//
//   upload_tags       — the vocabulary (one row per distinct tag name)
//   attachment_tags   — the association (message + file → tag)
//
// Applying an existing tag is open to any uploader; minting a NEW tag is gated
// by the manage_tags permission (enforced by the caller via `canCreate`). New
// tags are committed here on message send (get-or-create by normalized name),
// never speculatively from the composer — an abandoned draft leaves no orphans.

// Phase 1 hardcodes these; a later admin-settings pass swaps them for
// server_settings reads. The hard technical ceilings the future setting is
// clamped to live alongside the defaults.
const MAX_TAG_LEN = 20;          // default; hard ceiling for the admin setting
const MAX_TAG_LEN_CEIL = 50;
const MAX_TAGS_PER_ATTACHMENT = 3;    // default; hard ceiling for the setting
const MAX_TAGS_CEIL = 10;

// Letters (any script), digits, space, hyphen, underscore. Everything else —
// control chars, punctuation, emoji — is rejected so tags stay clean, terse and
// reusable. Display keeps the user's casing; matching/dedupe is case-folded.
const TAG_CHARS = /^[\p{L}\p{N} _-]+$/u;

// Normalize a raw tag string into { name, norm } or null when it can't be a
// valid tag. `name` is the trimmed, whitespace-collapsed display form; `norm`
// is its case-folded key used for uniqueness and lookup.
function normalizeTagName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!name || name.length > MAX_TAG_LEN) return null;
  if (!TAG_CHARS.test(name)) return null;
  return { name, norm: name.toLocaleLowerCase() };
}

// Pull the first /uploads/<file> path out of a message body. Attachment
// messages carry exactly one — either a bare image URL or a [file:name](url|
// size) wrapper — so the first match identifies the file being tagged.
function extractUploadPath(content) {
  const m = String(content || '').match(/\/uploads\/[^\s)|"'<>]+/);
  return m ? m[0] : null;
}

// Escape LIKE wildcards so a query of "50%" or "a_b" matches literally.
function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, ch => '\\' + ch);
}

// Search the vocabulary for the composer's tag picker. Returns [{ id, name }].
// An empty query browses the whole vocabulary (the picker lists everything when
// it first opens); a non-empty one is a prefix match, which stays on the UNIQUE
// index and cheap. Both are capped so a huge vocabulary can't flood the popup.
function searchTags(db, query, limit = 50) {
  const lim = Math.max(1, Math.min(100, limit | 0));
  const raw = String(query || '').trim();
  if (!raw) {
    return db.prepare('SELECT id, name FROM upload_tags ORDER BY name_norm LIMIT ?').all(lim);
  }
  const norm = normalizeTagName(raw);
  if (!norm) return [];
  return db.prepare(
    `SELECT id, name FROM upload_tags
      WHERE name_norm LIKE ? ESCAPE '\\'
      ORDER BY name_norm LIMIT ?`
  ).all(escapeLike(norm.norm) + '%', lim);
}

// Attach `tagNames` to the file `content` carries, writing attachment_tags rows
// for the given message. Existing tags are reused; unknown names are minted only
// when `canCreate` is true (manage_tags) and otherwise silently dropped. Invalid
// names are skipped; the list is deduped and capped. One transaction; tolerant
// by design — the caller treats tagging as non-critical and never fails a send
// over it. Returns the applied tag names.
// Normalize, dedupe (by case-folded key, first-seen order) and cap a raw tag
// name list into [{ name, norm }]. Shared by the send-time and edit-time paths.
function pickTags(tagNames) {
  const seen = new Set();
  const picked = [];
  for (const raw of Array.isArray(tagNames) ? tagNames : []) {
    const norm = normalizeTagName(raw);
    if (!norm || seen.has(norm.norm)) continue;
    seen.add(norm.norm);
    picked.push(norm);
    if (picked.length >= MAX_TAGS_PER_ATTACHMENT) break;
  }
  return picked;
}

// Resolve `picked` tags to ids (minting unknown ones only when canCreate) and
// link each to (messageId, relPath). Existing links are left alone (OR IGNORE).
// Caller owns the transaction. Returns the applied display names.
function linkPickedTags(db, { messageId, relPath, picked, userId, canCreate }) {
  const findTag   = db.prepare('SELECT id FROM upload_tags WHERE name_norm = ?');
  const insertTag = db.prepare('INSERT INTO upload_tags (name, name_norm, created_by) VALUES (?, ?, ?)');
  const linkTag   = db.prepare('INSERT OR IGNORE INTO attachment_tags (message_id, rel_path, tag_id) VALUES (?, ?, ?)');
  const applied = [];
  for (const { name, norm } of picked) {
    let row = findTag.get(norm);
    if (!row) {
      if (!canCreate) continue;   // applying is open; creating needs manage_tags
      const res = insertTag.run(name, norm, userId || null);
      row = { id: res.lastInsertRowid };
    }
    linkTag.run(messageId, relPath, row.id);
    applied.push(name);
  }
  return applied;
}

function applyTagsToMessage(db, { messageId, content, tagNames, userId, canCreate }) {
  const relPath = extractUploadPath(content);
  if (!relPath || !Array.isArray(tagNames) || !tagNames.length) return [];
  const picked = pickTags(tagNames);
  if (!picked.length) return [];
  let applied = [];
  db.transaction(() => {
    applied = linkPickedTags(db, { messageId, relPath, picked, userId, canCreate });
  })();
  return applied;
}

// Replace the full tag set on a message's attachment (retroactive edit). Unlike
// applyTagsToMessage this is not additive: it clears the message's existing
// links first, so an empty list removes every tag. Returns the applied names.
function setMessageTags(db, { messageId, content, tagNames, userId, canCreate }) {
  const relPath = extractUploadPath(content);
  if (!relPath) return [];
  const picked = pickTags(tagNames);
  let applied = [];
  db.transaction(() => {
    db.prepare('DELETE FROM attachment_tags WHERE message_id = ?').run(messageId);
    applied = linkPickedTags(db, { messageId, relPath, picked, userId, canCreate });
  })();
  return applied;
}

module.exports = {
  MAX_TAG_LEN,
  MAX_TAG_LEN_CEIL,
  MAX_TAGS_PER_ATTACHMENT,
  MAX_TAGS_CEIL,
  normalizeTagName,
  extractUploadPath,
  escapeLike,
  searchTags,
  applyTagsToMessage,
  setMessageTags,
};
