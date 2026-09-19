'use strict';

// ── Self-destructing attachments (#5690) ────────────────────────────────────
// A per-attachment deletion timer. One row per file in attachment_expiry
// (keyed like attachment_tags: message + file, rel_path keeps the "/uploads/"
// prefix). `expires_at` is when it should go; `destroyed_at` is stamped once it
// has, so the row survives as the record that the message HAD a self-destructing
// attachment — that is what drives the "self-destructed" line after the file is
// gone. Deleting the message clears its rows through ON DELETE CASCADE.
//
// The sweep here runs at boot and on a 10s interval, independent of any socket
// connection, so timers that came due while the server was down are honored the
// moment it starts back up. Finalizing means: remove the file for good (never
// into deleted-attachments), strip its reference and tags off the message, and
// stamp destroyed_at. The message's countdown/"destroyed" line is metadata the
// client renders from selfDestructStateForMessages — the message content is
// only ever edited to drop the dead reference, never to carry the note.

const fs = require('fs');
const path = require('path');

const SELF_DESTRUCT_MIN = 2;      // minutes
const SELF_DESTRUCT_MAX = 1440;   // minutes (24h)

// Validate the composer's self-destruct value: whole minutes in range, or null.
function parseSelfDestructMinutes(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < SELF_DESTRUCT_MIN || n > SELF_DESTRUCT_MAX) return null;
  return n;
}

// Same rule as the uploads path guard in the message handler: no absolute
// paths, no traversal, plain path segments only. Operates on the rel form
// (without the "/uploads/" prefix).
function isSafeUploadRelPath(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (!/^((?!\.\.)(?!\.\/)(?!\/)[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(relPath)) return false;
  const parts = relPath.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) return false;
  return true;
}

// rel_path / content carry "/uploads/<file>"; filesystem work wants it without
// the prefix, which is what UPLOADS_DIR is joined with.
function uploadUrlToRel(url) {
  return String(url || '').replace(/^\/uploads\//, '');
}

// Delete the backing file for good. Best-effort: a missing/locked file just
// means the reference cleanup still runs.
function purgeUploadForGood(uploadsDir, url) {
  const rel = uploadUrlToRel(url);
  if (!isSafeUploadRelPath(rel)) return;
  try {
    const src = path.join(uploadsDir, rel);
    const stat = fs.statSync(src);
    if (stat.isFile()) fs.unlinkSync(src);
  } catch { /* already gone or locked */ }
}

// True when the file for an upload url is no longer on disk (deleted or moved
// out from under the message before its timer fired).
function uploadFileMissing(uploadsDir, url) {
  const rel = uploadUrlToRel(url);
  if (!isSafeUploadRelPath(rel)) return false;
  return !fs.existsSync(path.join(uploadsDir, rel));
}

// Strip every reference to a now-deleted upload out of a message body. Covers
// the three shapes an attachment takes in content: a bare /uploads URL, a
// spoiler-img: wrapper, and a [file:name](/uploads/..|size) wrapper. Trailing
// whitespace/blank lines are collapsed.
function stripUploadRef(content, url) {
  if (typeof content !== 'string' || !content) return content || '';
  const esc = String(url).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = content;
  out = out.replace(new RegExp('\\[file:[^\\]]*\\]\\(' + esc + '(?:\\|[^)]*)?\\)', 'g'), '');
  out = out.replace(new RegExp('spoiler-img:' + esc, 'g'), '');
  out = out.replace(new RegExp(esc, 'g'), '');
  return out.replace(/\n{3,}/g, '\n\n').replace(/^\s+|\s+$/g, '');
}

// The client payload for a set of messages: id → { pending, destroyed, expiresAt }.
// `pending` is how many timers are still ticking (drives the countdown, with
// the soonest expiry), `destroyed` how many have already fired (drives the
// "self-destructed" line). Only messages that have at least one row appear.
function selfDestructStateForMessages(db, msgIds) {
  const out = new Map();
  const ids = (Array.isArray(msgIds) ? msgIds : []).filter(Number.isInteger);
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT message_id, expires_at, destroyed_at FROM attachment_expiry WHERE message_id IN (${ph})`
    ).all(...ids);
  } catch { return out; }
  for (const r of rows) {
    let s = out.get(r.message_id);
    if (!s) { s = { pending: 0, destroyed: 0, expiresAt: null }; out.set(r.message_id, s); }
    if (r.destroyed_at) {
      s.destroyed++;
    } else {
      s.pending++;
      if (!s.expiresAt || r.expires_at < s.expiresAt) s.expiresAt = r.expires_at;
    }
  }
  return out;
}

// Single-message convenience for the live send/broadcast payloads.
function selfDestructStateForMessage(db, messageId) {
  return selfDestructStateForMessages(db, [messageId]).get(messageId) || null;
}

// One finalize pass. Returns the number of attachments destroyed. Broadcasts
// `attachment-self-destructed` per affected message with the rewritten content
// and the fresh self-destruct state so open clients flip the line in place.
function sweepSelfDestruct(db, io, uploadsDir) {
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT ae.message_id, ae.rel_path, ae.expires_at, m.content, c.code AS channel_code
      FROM attachment_expiry ae
      JOIN messages m ON m.id = ae.message_id
      JOIN channels c ON c.id = m.channel_id
      WHERE ae.destroyed_at IS NULL
      ORDER BY ae.expires_at ASC LIMIT 500
    `).all();
  } catch (err) { console.error('[self-destruct-sweep] query error:', err.message); return 0; }
  if (!rows.length) return 0;

  const now = Date.now();
  const byMessage = new Map();
  for (const r of rows) {
    const due = Date.parse(r.expires_at) <= now;
    const gone = !due && uploadFileMissing(uploadsDir, r.rel_path);
    if (!due && !gone) continue;
    if (!byMessage.has(r.message_id)) byMessage.set(r.message_id, { code: r.channel_code, content: r.content, paths: [] });
    byMessage.get(r.message_id).paths.push(r.rel_path);
  }
  if (!byMessage.size) return 0;

  const markDone   = db.prepare('UPDATE attachment_expiry SET destroyed_at = ? WHERE message_id = ? AND rel_path = ?');
  const delTags    = db.prepare('DELETE FROM attachment_tags WHERE message_id = ? AND rel_path = ?');
  const updContent = db.prepare('UPDATE messages SET content = ? WHERE id = ?');
  let destroyed = 0;
  const stamp = new Date().toISOString();
  for (const [messageId, info] of byMessage) {
    try {
      let content = info.content || '';
      for (const rel of info.paths) {
        purgeUploadForGood(uploadsDir, rel);
        content = stripUploadRef(content, rel);
        delTags.run(messageId, rel);
        markDone.run(stamp, messageId, rel);
        destroyed++;
      }
      updContent.run(content, messageId);
      if (io) {
        io.to(`channel:${info.code}`).emit('attachment-self-destructed', {
          channelCode: info.code,
          messageId,
          content,
          selfDestruct: selfDestructStateForMessage(db, messageId),
        });
      }
    } catch (err) {
      console.error('[self-destruct-sweep] finalize error:', err.message);
    }
  }
  return destroyed;
}

// Run one pass immediately (catches timers that came due while the server was
// down) and then every 10 seconds. Guarded so it starts only once per process.
function startSelfDestructSweeper(db, io, uploadsDir) {
  if (global.__havenAttachmentExpirySweep) return;
  try {
    const n = sweepSelfDestruct(db, io, uploadsDir);
    if (n > 0) console.log(`[self-destruct] finalized ${n} expired attachment(s) at startup`);
  } catch (err) { console.error('[self-destruct] startup sweep error:', err.message); }
  global.__havenAttachmentExpirySweep = setInterval(() => sweepSelfDestruct(db, io, uploadsDir), 10000);
}

module.exports = {
  SELF_DESTRUCT_MIN,
  SELF_DESTRUCT_MAX,
  parseSelfDestructMinutes,
  isSafeUploadRelPath,
  uploadUrlToRel,
  stripUploadRef,
  selfDestructStateForMessages,
  selfDestructStateForMessage,
  sweepSelfDestruct,
  startSelfDestructSweeper,
};
