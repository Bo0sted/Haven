'use strict';

// The two outside programs Haven leans on for photos and videos: exiftool
// (reads and writes metadata) and ffmpeg (rewrites video files). Both are
// required for photo and video uploads; see src/privacyPass.js for why.
//
// Each is looked for, in order, at the path in its environment variable, in
// the data folder's tools/ (where Haven's own download puts it), and on the
// PATH. Whichever answers its version check first is used.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { DATA_DIR } = require('./paths');

const TOOLS_DIR = path.join(DATA_DIR, 'tools');
const EXE = process.platform === 'win32' ? '.exe' : '';

const TOOLS = {
  exiftool: {
    env: 'HAVEN_EXIFTOOL_PATH',
    local: [path.join(TOOLS_DIR, 'exiftool', 'exiftool' + EXE)],
    name: 'exiftool',
    args: ['-ver'],
    version: (out) => (/^\d+\.\d+/.exec(out.trim()) || [])[0] || null,
  },
  ffmpeg: {
    env: 'HAVEN_FFMPEG_PATH',
    local: [path.join(TOOLS_DIR, 'ffmpeg', 'ffmpeg' + EXE)],
    name: 'ffmpeg',
    args: ['-hide_banner', '-version'],
    version: (out) => (/ffmpeg version (\S+)/.exec(out) || [])[1] || null,
  },
};

const found = { exiftool: null, ffmpeg: null };

function probe(tool, candidate) {
  try {
    const r = spawnSync(candidate, TOOLS[tool].args, { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.error || r.status !== 0) return null;
    const version = TOOLS[tool].version(r.stdout || '');
    return version ? { path: candidate, version } : null;
  } catch { return null; }
}

/** Look for both tools again. Returns true when both are usable. */
function locateTools() {
  for (const tool of Object.keys(TOOLS)) {
    const t = TOOLS[tool];
    const candidates = [process.env[t.env], ...t.local.filter(p => fs.existsSync(p)), t.name].filter(Boolean);
    found[tool] = null;
    for (const c of candidates) {
      const hit = probe(tool, c);
      if (hit) { found[tool] = hit; break; }
    }
  }
  return toolsReady();
}

function toolsReady() { return !!(found.exiftool && found.ffmpeg); }
function missingTools() { return Object.keys(found).filter(t => !found[t]); }
function toolPath(tool) { return found[tool]?.path || null; }
function toolInfo() { return { exiftool: found.exiftool?.version || null, ffmpeg: found.ffmpeg?.version || null }; }

// Photo and video work never gets ahead of chat and voice.
function lowerPriority(child) {
  try { os.setPriority(child.pid, os.constants.priority.PRIORITY_LOW); } catch { /* not permitted here: runs at normal priority */ }
}

/**
 * Run a tool to completion. Resolves { code, stdout, stderr }; never rejects
 * on a non-zero exit, only when the program cannot be started at all.
 * `signal` stops it early, `onStdout` sees output as it arrives.
 */
function run(tool, args, { signal, onStdout, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (!found[tool]) return reject(Object.assign(new Error(`${tool} is not installed`), { code: 'TOOL_MISSING' }));
    const child = spawn(found[tool].path, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    lowerPriority(child);
    let stdout = '', stderr = '', settled = false;
    const kill = () => { try { child.kill('SIGKILL'); } catch { /* already gone */ } };
    const timer = timeoutMs ? setTimeout(kill, timeoutMs) : null;
    const onAbort = () => kill();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { if (stdout.length < 4e6) stdout += d; onStdout?.(d); });
    child.stderr.on('data', (d) => { if (stderr.length < 1e6) stderr += d; });
    const finish = (fn) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn();
    };
    child.on('error', (err) => finish(() => reject(err)));
    child.on('close', (code) => finish(() => resolve({ code, stdout, stderr, aborted: !!signal?.aborted })));
  });
}

// ── exiftool, kept running ───────────────────────────────
// Starting exiftool costs more than reading a photo does, so one copy stays
// open in its -stay_open mode and takes commands one at a time. Each command
// ends with a numbered marker on both outputs so replies cannot be mixed up.
let et = null;

function startExiftool() {
  const child = spawn(found.exiftool.path, ['-stay_open', 'True', '-@', '-'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  lowerPriority(child);
  const state = { child, queue: [], current: null, out: '', err: '', seq: 0 };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const check = () => {
    const job = state.current;
    if (!job) return;
    const marker = `{ready${job.id}}`;
    const oi = state.out.indexOf(marker), ei = state.err.indexOf(marker);
    if (oi === -1 || ei === -1) return;
    const stdout = state.out.slice(0, oi), stderr = state.err.slice(0, ei);
    state.out = state.out.slice(oi + marker.length).replace(/^\r?\n/, '');
    state.err = state.err.slice(ei + marker.length).replace(/^\r?\n/, '');
    clearTimeout(job.timer);
    state.current = null;
    job.resolve({ stdout, stderr });
    next(state);
  };
  child.stdout.on('data', (d) => { state.out += d; check(); });
  child.stderr.on('data', (d) => { state.err += d; check(); });
  const fail = (err) => {
    if (et === state) et = null;
    const jobs = [state.current, ...state.queue].filter(Boolean);
    state.current = null; state.queue = [];
    for (const j of jobs) { clearTimeout(j.timer); j.reject(err); }
  };
  child.on('error', fail);
  child.on('close', () => fail(new Error('exiftool stopped unexpectedly')));
  child.stdin.on('error', () => { /* reported through close */ });
  return state;
}

function next(state) {
  if (state.current || !state.queue.length) return;
  const job = state.current = state.queue.shift();
  job.timer = setTimeout(() => {
    // A file that hangs exiftool takes the process with it; the next call
    // starts a fresh one.
    try { state.child.kill('SIGKILL'); } catch { /* already gone */ }
  }, job.timeoutMs);
  const lines = [...job.args, `-echo4`, `{ready${job.id}}`, `-execute${job.id}`];
  state.child.stdin.write(lines.join('\n') + '\n');
}

/** One exiftool command on the long-running copy. Resolves { stdout, stderr }. */
function exiftool(args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!found.exiftool) return reject(Object.assign(new Error('exiftool is not installed'), { code: 'TOOL_MISSING' }));
    if (args.some(a => /[\r\n]/.test(a))) return reject(new Error('exiftool argument contains a line break'));
    if (!et) et = startExiftool();
    et.seq += 1;
    et.queue.push({ id: et.seq, args: ['-charset', 'filename=utf8', ...args], resolve, reject, timeoutMs });
    next(et);
  });
}

function stopExiftool() {
  if (!et) return;
  try { et.child.stdin.write('-stay_open\nFalse\n'); } catch { /* already gone */ }
  et = null;
}

// ── Downloading them ─────────────────────────────────────
// When either is not installed, Haven fetches a pinned version from GitHub
// into the data folder's tools/ and checks it against a fixed SHA-256 before
// using it, so a changed or tampered file is refused rather than run.
// ExifTool comes from its author's own repository (the program and library
// are byte for byte the release on exiftool.org); it is a Perl program, so it
// needs Perl, which Linux and macOS ship. Its Windows build is not on GitHub,
// so on Windows it is installed by hand. ffmpeg comes from the ffmpeg-static
// project's release, which packages the widely used static builds for each
// platform as a single file. Turn downloading off with
// HAVEN_NO_TOOL_DOWNLOAD=1 and install both yourself.

const EXIFTOOL_DOWNLOAD = {
  url: 'https://github.com/exiftool/exiftool/archive/refs/tags/13.59.tar.gz',
  sha256: '87d3317882fdae9cb4dcfe57a96a378d0132ffc02c731315bf128b19ddcf7aac',
};
const FFMPEG_RELEASE = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';
// SHA-256 of the gzipped download, then of the program inside it.
const FFMPEG_DOWNLOADS = {
  'linux-x64':    ['bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa', 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99'],
  'linux-arm64':  ['754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0', '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce'],
  'darwin-x64':   ['929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106', 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894'],
  'darwin-arm64': ['8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa', 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584'],
  'win32-x64':    ['8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77', '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00'],
};

const sha256 = (buf) => require('crypto').createHash('sha256').update(buf).digest('hex');

async function fetchChecked(url, expected, maxBytes) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok) throw new Error(`${url} answered HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`${url} is larger than expected`);
  if (sha256(buf) !== expected) throw new Error(`${url} does not match its pinned checksum, so it was not used`);
  return buf;
}

async function downloadFfmpeg() {
  const key = `${process.platform}-${process.arch}`;
  const sums = FFMPEG_DOWNLOADS[key];
  if (!sums) throw new Error(`no ffmpeg download for ${key}; install ffmpeg yourself`);
  const gz = await fetchChecked(`${FFMPEG_RELEASE}/ffmpeg-${key}.gz`, sums[0], 64 * 1024 * 1024);
  const bin = require('zlib').gunzipSync(gz);
  if (sha256(bin) !== sums[1]) throw new Error('the unpacked ffmpeg does not match its pinned checksum');
  const dir = path.join(TOOLS_DIR, 'ffmpeg');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, 'ffmpeg' + EXE);
  fs.writeFileSync(dest + '.part', bin, { mode: 0o755 });
  fs.renameSync(dest + '.part', dest);
}

async function downloadExiftool() {
  if (process.platform === 'win32') {
    throw new Error('ExifTool for Windows is not on GitHub; install it from https://exiftool.org and set HAVEN_EXIFTOOL_PATH');
  }
  const archive = await fetchChecked(EXIFTOOL_DOWNLOAD.url, EXIFTOOL_DOWNLOAD.sha256, 64 * 1024 * 1024);
  const staging = path.join(TOOLS_DIR, `exiftool-${Date.now()}.part`);
  fs.mkdirSync(staging, { recursive: true });
  try {
    // tar ships with every system this runs on.
    const file = path.join(staging, 'exiftool.tar.gz');
    fs.writeFileSync(file, archive);
    const r = spawnSync('tar', ['-xzf', file, '-C', staging], { timeout: 60000 });
    if (r.status !== 0) throw new Error(`could not unpack exiftool: ${String(r.stderr || r.error?.message || '').trim()}`);
    fs.unlinkSync(file);
    const top = fs.readdirSync(staging).find(n => /exiftool/i.test(n) && fs.statSync(path.join(staging, n)).isDirectory());
    if (!top) throw new Error('the exiftool download did not contain the expected folder');
    const dest = path.join(TOOLS_DIR, 'exiftool');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(path.join(staging, top), dest);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * Download whichever tools are missing, then look again. Resolves true when
 * both are usable. Every failure is logged and leaves the tool missing.
 */
async function downloadMissingTools() {
  if (process.env.HAVEN_NO_TOOL_DOWNLOAD === '1') return toolsReady();
  for (const tool of missingTools()) {
    console.log(`⬇️  [privacy] Downloading ${tool}…`);
    try {
      await (tool === 'ffmpeg' ? downloadFfmpeg() : downloadExiftool());
    } catch (err) {
      console.error(`[privacy] Could not download ${tool}: ${err.message}`);
    }
  }
  const ok = locateTools();
  if (!ok && found.exiftool === null && process.platform !== 'win32' && fs.existsSync(path.join(TOOLS_DIR, 'exiftool', 'exiftool'))) {
    console.error('[privacy] exiftool was downloaded but will not run. It needs Perl; install perl and restart.');
  }
  return ok;
}

module.exports = { TOOLS_DIR, locateTools, toolsReady, missingTools, toolInfo, toolPath, run, exiftool, stopExiftool, downloadMissingTools };
