'use strict';

// Self-destructing messages. A message sent with a timer carries destruct_at;
// once that passes, the message goes and so do the sender's own files it
// attached. Those files are unlinked straight away instead of moving to
// deleted-attachments, since the sender asked for them to be gone.
//
// One timer waits for the soonest deadline. When it fires it deletes what is
// due and waits for the next one, or sleeps when none is left. A new message
// with a sooner deadline wakes it (schedule), and deleting the message it is
// waiting for moves it on (forget). It runs once at startup, so anything that
// came due while the server was down goes first.

const fs = require('fs');
const path = require('path');
const { UPLOADS_DIR } = require('./paths');

const MAX_DESTRUCT_SECONDS = 24 * 60 * 60;
// When a due message could not be deleted, try again after this instead of
// firing again at once in a loop.
const RETRY_MS = 30 * 1000;

let run = null;       // set by start()
let timer = null;
let armedFor = null;  // ms of the deadline the timer is waiting for, null while asleep

/** destruct_at for a requested timer, or null when there is none or it is out of range. */
function destructAtFromSeconds(raw) {
  const secs = Number(raw);
  if (!Number.isFinite(secs) || secs < 1 || secs > MAX_DESTRUCT_SECONDS) return null;
  return new Date(Date.now() + Math.round(secs) * 1000).toISOString();
}

function arm(at) {
  clearTimeout(timer);
  timer = null;
  armedFor = Number.isFinite(at) ? at : null;
  if (armedFor !== null) timer = setTimeout(run, Math.max(0, armedFor - Date.now()));
}

/** A self-destructing message was sent: wake up if it is due sooner. */
function schedule(destructAt) {
  const at = Date.parse(destructAt);
  if (run && Number.isFinite(at) && (armedFor === null || at < armedFor)) arm(at);
}

/** A self-destructing message was deleted early. Only the one the timer is
 *  waiting for matters; then it waits for the next, or sleeps. */
function forget(destructAt) {
  if (run && armedFor !== null && Date.parse(destructAt) === armedFor) run();
}

function start({ db, io, UPLOAD_PATH_RE, isSafeUploadRelPath }) {
  const due = db.prepare(`
    SELECT m.id, m.user_id, m.content, c.code
    FROM messages m JOIN channels c ON c.id = m.channel_id
    WHERE m.destruct_at IS NOT NULL AND m.destruct_at <= ?
    ORDER BY m.destruct_at ASC LIMIT 200
  `);
  const next = db.prepare('SELECT MIN(destruct_at) AS at FROM messages WHERE destruct_at IS NOT NULL');
  // Only the sender's own attachments, so naming someone else's file in a
  // self-destructing message cannot get it removed. Other messages that link
  // to it (a quote, a paste) do not keep it alive.
  const ownFile = db.prepare("SELECT 1 FROM upload_ownership WHERE rel_path = ? AND user_id = ? AND scope IN ('channel', 'dm')");
  const removeOne = db.transaction((id) => {
    db.prepare('DELETE FROM pinned_messages WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM reactions WHERE message_id = ?').run(id);
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
  });

  const sweep = () => {
    let rows;
    try { rows = due.all(new Date().toISOString()); } catch (err) {
      console.error('[self-destruct] query error:', err.message);
      return 0;
    }
    let removed = 0;
    for (const row of rows) {
      try {
        removeOne(row.id);
        UPLOAD_PATH_RE.lastIndex = 0;
        const paths = new Set();
        let m;
        while ((m = UPLOAD_PATH_RE.exec(row.content || '')) !== null) paths.add(m[1]);
        for (const rel of paths) {
          if (!isSafeUploadRelPath(rel) || !ownFile.get(rel, row.user_id)) continue;
          try { fs.unlinkSync(path.join(UPLOADS_DIR, rel)); } catch (err) {
            if (err.code !== 'ENOENT') console.warn(`[self-destruct] Could not remove ${rel}:`, err.message);
          }
        }
        io.to(`channel:${row.code}`).emit('message-deleted', { channelCode: row.code, messageId: row.id });
        removed++;
      } catch (err) {
        console.error('[self-destruct] delete error:', err.message);
      }
    }
    return removed;
  };

  // Wait for the soonest deadline left. One already past means more than a
  // batch was due (go again now) or a row would not delete (back off).
  const rearm = (removed) => {
    let at = null;
    try { at = Date.parse(next.get()?.at || ''); } catch (err) {
      console.error('[self-destruct] query error:', err.message);
    }
    if (at <= Date.now() && !removed) at = Date.now() + RETRY_MS;
    arm(at);
  };

  run = () => rearm(sweep());
  run();
}

/** Stop the timer (tests, shutdown). */
function stop() {
  arm(null);
  run = null;
}

module.exports = { MAX_DESTRUCT_SECONDS, destructAtFromSeconds, start, schedule, forget, stop };
