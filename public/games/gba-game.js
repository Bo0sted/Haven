// Haven — GBA Game Loader (EmulatorJS)
// Query gives ?rom=URL&title=NAME; the auth token rides in the hash
// (#token=...) so it never appears in the URL the server logs.
const params = new URLSearchParams(window.location.search);
const romUrl = params.get('rom');
const title = params.get('title') || 'GBA Game';
const token = new URLSearchParams(location.hash.slice(1)).get('token') || '';
const romFile = decodeURIComponent((romUrl || '').split('/').pop() || '');

// Save-sync diagnostics — off by default; enable in the console with
// localStorage.setItem('haven_save_debug', '1') then reload.
const SAVE_DEBUG = (() => { try { return localStorage.getItem('haven_save_debug') === '1'; } catch { return false; } })();
function dbg(...a) { if (SAVE_DEBUG) console.log('[Haven save]', ...a); }
function dwarn(...a) { if (SAVE_DEBUG) console.warn('[Haven save]', ...a); }

document.getElementById('game-title').textContent = title;
document.title = `${title} — Haven`;

// ── Volume control ──────────────────────────────────────
const volSlider = document.getElementById('volume-slider');
const volPct = document.getElementById('volume-pct');

volSlider.addEventListener('input', () => {
  const val = parseInt(volSlider.value);
  volPct.textContent = val + '%';
  applyVolume(val);
});

function applyVolume(val) {
  // EmulatorJS exposes the running instance on window.EJS_emulator once started
  try {
    if (window.EJS_emulator && typeof window.EJS_emulator.setVolume === 'function') {
      window.EJS_emulator.setVolume(val / 100);
    }
  } catch {}
}

function showError(msg) {
  const el = document.getElementById('loading-msg');
  if (el) el.innerHTML = `<div class="error-msg">${msg}</div>`;
}

// Transient green status toast (save loaded / synced). Auto-dismisses after
// 10s; does not persist, unlike the offline bar.
let toastTimer = null;
function showToast(msg) {
  let el = document.getElementById('game-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'game-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.display = 'block';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, 10000);
}

// Map a ROM's extension to the EmulatorJS core. Gambatte ('gb') runs both Game
// Boy and Game Boy Color; mGBA ('gba') runs Game Boy Advance.
function coreForRom(url) {
  return /\.gba(?:$|\?)/i.test(url || '') ? 'gba' : 'gb';
}

// EmulatorJS renders through WebGL; browsers with it disabled (e.g. hardened
// builds like LibreWolf) can't display games. Warn once, but don't block —
// let the user try anyway.
function warnIfNoWebGL() {
  let ok = false;
  try {
    const c = document.createElement('canvas');
    ok = !!(window.WebGLRenderingContext && (c.getContext('webgl') || c.getContext('experimental-webgl')));
  } catch {}
  if (ok) return;
  const w = document.getElementById('webgl-warning');
  if (!w) return;
  w.style.display = 'flex';
  w.querySelector('#webgl-warning-ok').onclick = () => { w.style.display = 'none'; };
}
warnIfNoWebGL();

// One-time notice that only in-game battery saves sync to the server (save
// states are local only). "Don't show again" persists via a localStorage
// nodisplay key, mirroring Haven's other dismissible modals.
function showSaveInfo() {
  if (localStorage.getItem('haven_gba_saveinfo_nodisplay')) return;
  const m = document.getElementById('save-info');
  if (!m) return;
  m.style.display = 'flex';
  m.querySelector('#save-info-ok').onclick = () => {
    if (m.querySelector('#save-info-dsa').checked) {
      try { localStorage.setItem('haven_gba_saveinfo_nodisplay', '1'); } catch {}
    }
    m.style.display = 'none';
  };
}
showSaveInfo();

// ── Battery-save sync ───────────────────────────────────
// The server is the source of truth: we pull the user's save at boot, and push
// on every in-game save. save_key = SHA-256(filename + rom bytes), so two
// library copies of a game keep independent saves. See server /api/game-saves.
let saveKey = null;          // this save's identity, or null if sync unavailable
let lastSynced = null;       // bytes last confirmed on the server (change diffing)
let syncArmed = false;       // true only after boot pull+inject — stops a fresh
                             //   empty SRAM from clobbering the server pre-load
let offline = false;         // last push failed / server unreachable
let serverAbsent = false;    // server DEFINITIVELY reported no save (X-Haven-Save: absent)
let syncedKey = null;        // localStorage key: this save was synced on THIS device
let pollTimer = null, retryTimer = null, retryDelay = 5000;

// Per-device "synced with the server at least once" marker. It lets a deletion
// be told apart from an offline-only local save: we wipe a local copy on a
// definitive "absent" ONLY if this marker exists. Set on a successful pull
// (present) or push; never set speculatively.
function markSynced() { if (syncedKey) try { localStorage.setItem(syncedKey, '1'); } catch {} }
function wasSynced() { if (!syncedKey) return false; try { return localStorage.getItem(syncedKey) === '1'; } catch { return false; } }
function clearSyncedMark() { if (syncedKey) try { localStorage.removeItem(syncedKey); } catch {} }

function bytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// Lightweight position-weighted fingerprint for diagnostics — distinguishes
// two different save snapshots in the console without hashing 128 KB.
function fp(bytes) {
  let h = 0;
  for (let i = 0; i < bytes.length; i++) h = (h + bytes[i] * (i + 1)) >>> 0;
  return bytes.length + ':' + h.toString(16);
}

// True if the SRAM is uniformly 0x00 or 0xFF — an erased/blank cartridge. This
// is what a fresh boot looks like before a save is loaded; it must NEVER be
// pushed, or it would wipe a real save on the server.
function isBlank(bytes) {
  if (!bytes || !bytes.length) return true;
  const f = bytes[0];
  if (f !== 0x00 && f !== 0xFF) return false;
  for (let i = 1; i < bytes.length; i++) if (bytes[i] !== f) return false;
  return true;
}

// Hash needs a secure context for crypto.subtle (always true on https and on
// localhost). Elsewhere sync is disabled and saves stay browser-local.
async function computeSaveKey(bytes) {
  if (!window.crypto?.subtle) return null;
  const name = new TextEncoder().encode(romFile);
  const buf = new Uint8Array(name.length + bytes.length);
  buf.set(name, 0); buf.set(bytes, name.length);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Current SRAM bytes from the running core, or null if not ready.
function readSram() {
  try {
    const b = window.EJS_emulator?.gameManager?.getSaveFile?.();
    return b ? new Uint8Array(b) : null;
  } catch { return null; }
}

// fetch that rejects if the server doesn't answer within REQ_TIMEOUT_MS. A dead
// connection (yanked wifi, unlike DevTools "offline") doesn't fail the request —
// it hangs in "pending" for the OS's long TCP timeout — so without this the
// offline handling never fires and the boot pull can stall the whole loader.
const REQ_TIMEOUT_MS = 8000;
function fetchWithTimeout(url, opts) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQ_TIMEOUT_MS);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function loadGame() {
  if (!romUrl) { showError('No ROM file specified'); return; }

  // Fetch the ROM ourselves to hash it; EmulatorJS then re-fetches from cache.
  let serverSave = null;
  try {
    const romBytes = new Uint8Array(await (await fetch(romUrl)).arrayBuffer());
    saveKey = await computeSaveKey(romBytes);
  } catch {}
  syncedKey = saveKey ? 'haven_gba_synced_' + saveKey : null;

  // PULL: ask the server for this save. The response carries X-Haven-Save:
  // present|absent — a marker only our route emits — plus no-store so we always
  // see live state. "present" → the server's save wins (inject). "absent" is a
  // trustworthy "no save here". ANY other outcome (missing header, non-200,
  // network error) is treated as UNKNOWN and never touches the local save —
  // that is the guard against wrongful wipes / data loss.
  if (saveKey && token) {
    try {
      const res = await fetchWithTimeout(`/api/game-saves/${saveKey}?_=${Date.now()}`, {
        headers: { Authorization: 'Bearer ' + token }, cache: 'no-store'
      });
      const mark = res.headers.get('X-Haven-Save');
      if (res.ok && mark === 'present') {
        serverSave = new Uint8Array(await res.arrayBuffer());
        markSynced();
        dbg('pulled', serverSave.length, 'bytes, key', saveKey.slice(0, 12) + '…');
      } else if (res.ok && mark === 'absent') {
        serverAbsent = true;
        dbg('server reports absent, key', saveKey.slice(0, 12) + '… (synced-before=' + wasSynced() + ')');
      } else {
        dbg('pull inconclusive (status ' + res.status + ', mark=' + mark + ') — local left untouched');
      }
    } catch (e) { offline = true; dwarn('pull failed:', e); }
  } else {
    dbg('sync disabled (saveKey=' + !!saveKey + ', token=' + !!token + ')');
  }

  // EmulatorJS reads these globals, then loader.js boots the emulator into #game.
  window.EJS_player = '#game';
  window.EJS_core = coreForRom(romUrl);
  window.EJS_gameUrl = romUrl;
  window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';  // official CDN, stable channel
  window.EJS_startOnLoaded = true;
  window.EJS_volume = parseInt(volSlider.value) / 100;
  window.EJS_ready = () => waitForCoreThenInject(serverSave);  // inject once the core is up
  window.EJS_onSaveUpdate = () => syncNow();                   // fires when EmulatorJS detects a SRAM change

  // Load EmulatorJS from the official CDN (client-side, like Ruffle for Flash)
  const script = document.createElement('script');
  script.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
  script.onload = () => { document.getElementById('loading-msg')?.remove(); };
  script.onerror = () => showError('Failed to load EmulatorJS emulator.<br>Check your internet connection.');
  document.head.appendChild(script);
}

// EJS_ready fires before the game core exists, so gameManager isn't there yet.
// Poll until it is (SRAM readable), then inject. ~20s safety cap.
function waitForCoreThenInject(serverSave) {
  let tries = 0;
  const iv = setInterval(() => {
    tries++;
    const gm = window.EJS_emulator?.gameManager;
    let ready = false;
    try { ready = !!(gm && gm.getSaveFile && gm.getSaveFile()); } catch {}
    if (ready) { clearInterval(iv); injectAndArm(serverSave, gm); }
    else if (tries > 200) { clearInterval(iv); dwarn('core not ready after 20s; arming without inject'); injectAndArm(serverSave, gm || null); }
  }, 100);
}

// Write the pulled save into the emulator's filesystem and ask the core to load
// it (loadSaveFiles copies the save file into live SRAM), then arm syncing. We
// read the SRAM straight back and log MATCH/mismatch to confirm it took.
function injectAndArm(serverSave, gm) {
  try {
    if (serverSave && serverSave.length && !isBlank(serverSave) && gm) {
      const path = gm.getSaveFilePath();
      try { gm.FS.mkdirTree(path.split('/').slice(0, -1).join('/')); } catch {}
      gm.FS.writeFile(path, serverSave);
      gm.loadSaveFiles();
      lastSynced = serverSave;
      let after = null; try { const b = gm.getSaveFile(); after = b ? new Uint8Array(b) : null; } catch {}
      const matched = after && bytesEqual(after, serverSave);
      dbg('inject → ' + path + '; readback ' + (after ? fp(after) : 'null') + ' vs server ' + fp(serverSave) + (matched ? ' ✓ MATCH' : ' ✗ mismatch'));
      if (matched) showToast('Save loaded from your profile');
    } else if (serverAbsent && wasSynced() && gm) {
      // Server DEFINITIVELY reports no save (X-Haven-Save: absent) AND this
      // device had synced it before → it was deleted elsewhere. Wipe the local
      // copy so the empty server stays authoritative. Only reachable on that
      // unambiguous signal — never on an error, plain 404, or network drop, and
      // never for an offline-only save (no synced marker).
      wipeLocalSave(gm);   // clears the synced marker itself, only on success
    } else {
      dbg('no inject (serverSave=' + (serverSave ? serverSave.length : 0) + ', absent=' + serverAbsent + ', synced=' + wasSynced() + ', gm=' + !!gm + ')');
    }
  } catch (e) { dwarn('inject failed:', e); }
  // Seed the baseline from current SRAM (non-blank only) so we push real changes.
  if (!lastSynced) { const s = readSram(); if (s && !isBlank(s)) lastSynced = s; }
  syncArmed = true;
  if (!pollTimer) pollTimer = setInterval(syncNow, 4000);  // fallback to EJS_onSaveUpdate
}

// Blank the local SRAM to erased-cartridge state so a server-side deletion takes
// effect on this device. Same proven FS + loadSaveFiles path as inject; the
// blank-guard then keeps this erased SRAM from ever being pushed back up.
function wipeLocalSave(gm) {
  try {
    const cur = gm.getSaveFile();
    const len = cur ? cur.length : 0;
    if (!len) { dbg('wipe skipped (no local save file)'); return; }
    const blank = new Uint8Array(len).fill(0xFF);
    gm.FS.writeFile(gm.getSaveFilePath(), blank);
    gm.loadSaveFiles();
    lastSynced = blank;   // baseline blank; isBlank guard keeps it off the server
    clearSyncedMark();    // deletion applied here → drop the marker (only on success)
    dbg('local save wiped (deleted server-side), ' + len + ' bytes → 0xFF');
  } catch (e) { dwarn('wipe failed:', e); }
}

// Push the current SRAM if it changed since the last synced copy. A single
// in-game save writes SRAM in several stages, so debounce ~1.5s and push once
// the save settles rather than firing on each intermediate state.
let pushDebounce = null;
function syncNow() {
  if (!syncArmed || !saveKey || !token) return;
  const cur = readSram();
  if (!cur || !cur.length || isBlank(cur) || bytesEqual(cur, lastSynced)) return;
  if (pushDebounce) clearTimeout(pushDebounce);
  pushDebounce = setTimeout(() => {
    pushDebounce = null;
    const c = readSram();
    if (c && c.length && !isBlank(c) && !bytesEqual(c, lastSynced)) {
      dbg('change detected → pushing', fp(c));
      pushSave(c);
    }
  }, 1500);
}

async function pushSave(bytes) {
  try {
    const res = await fetchWithTimeout('/api/game-saves', {
      method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: saveForm(bytes)
    });
    if (!res.ok) throw new Error('server ' + res.status);
    lastSynced = bytes;
    markSynced();
    showToast('Save synced to your profile');
    dbg('push OK', fp(bytes));
    if (offline) { offline = false; hideOfflineBar(); }
  } catch (err) {
    dwarn('push failed:', err);
    // Failed → treat as offline: surface a manual download and retry with backoff.
    offline = true;
    showOfflineBar(bytes);
    if (!retryTimer) retryTimer = setTimeout(() => {
      retryTimer = null;
      const cur = readSram();
      if (cur && cur.length && !bytesEqual(cur, lastSynced)) { retryDelay = Math.min(retryDelay * 2, 60000); pushSave(cur); }
      else retryDelay = 5000;
    }, retryDelay);
  }
}

// Multipart body — lets sendBeacon flush on close; token in the body because a
// beacon cannot set an Authorization header.
function saveForm(bytes) {
  const fd = new FormData();
  fd.append('save_key', saveKey);
  fd.append('rom_file', romFile);
  fd.append('token', token);
  fd.append('data', new Blob([bytes]), 'save.sav');
  return fd;
}

// ── Offline handling ────────────────────────────────────
// Persistent bar (not a transient toast) while offline, with a one-click
// backup download — a user-initiated download always works, unlike one fired
// during page unload, which browsers block.
function showOfflineBar(bytes) {
  let el = document.getElementById('offline-bar');
  if (!el) {
    el = document.createElement('div');
    el.id = 'offline-bar';
    // In-flow, directly above the game container (not overlaying the canvas).
    const container = document.getElementById('game-container');
    container.parentNode.insertBefore(el, container);
  }
  el.innerHTML = `<span>⚠ Server unreachable — your save is kept locally and will sync when reconnected.</span>
                  <button id="offline-dl-btn">Download backup</button>`;
  el.querySelector('#offline-dl-btn').onclick = () => downloadSave(bytes);
  el.style.display = 'flex';
}
function hideOfflineBar() { const el = document.getElementById('offline-bar'); if (el) el.style.display = 'none'; }

function downloadSave(bytes) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = romFile.replace(/\.[^.]+$/, '') + '.sav';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Deterministic stop: if a save hasn't reached the server, block the close with
// the browser's native prompt and fire a final beacon (survives unload). When
// offline the beacon can't land, so auto-download as the escape hatch.
window.addEventListener('beforeunload', (e) => {
  const cur = readSram();
  if (!syncArmed || !saveKey || !token || !cur || !cur.length || isBlank(cur) || bytesEqual(cur, lastSynced)) return;
  try { navigator.sendBeacon('/api/game-saves', saveForm(cur)); } catch {}
  if (offline) downloadSave(cur);
  e.preventDefault();
  e.returnValue = '';
  return '';
});

loadGame();

// Listen for volume messages from parent (Haven game iframe header)
window.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'set-volume' && typeof e.data.volume === 'number') {
    const vol = Math.round(e.data.volume * 100);
    volSlider.value = vol;
    volPct.textContent = vol + '%';
    applyVolume(vol);
  }
});
