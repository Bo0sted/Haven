'use strict';

// ══════════════════════════════════════════════════════════════════════
// Auto-moderation engine (v3.42.0)
// ══════════════════════════════════════════════════════════════════════
//
// Two jobs:
//
//   1. Decide whether a piece of user-supplied text is allowed to exist,
//      based on the links it contains and an admin-configured domain policy.
//   2. Track repeat offences and escalate warn -> mute -> ban.
//
// Everything defaults to OFF. An existing server that upgrades gets the new
// tables and settings but no behaviour change until an admin opts in.
//
// ── Why the URL parsing here is more paranoid than it looks ──
//
// A domain allowlist is only as good as its ability to work out the real
// host of a link. Naive implementations lose to a handful of very old tricks,
// all of which this module handles explicitly:
//
//   https://youtube.com@evil.com/x   userinfo, real host is evil.com
//   https://evilyoutube.com/         suffix match without a dot boundary
//   https://youtube.com.evil.com/    same, from the other direction
//   https://аbout.com/               Cyrillic 'а', a different domain entirely
//   https://you<ZWSP>tube.com/       zero-width char splitting the hostname
//   hxxps://evil[.]com/              defanged, still readable by a human
//   [youtube.com](https://evil.com)  markdown label lying about its target
//   https://192.0.2.10/pics.rar      bare IP, no domain to match at all
//
// The rule throughout: never pattern-match a hostname out of raw text. Strip
// the invisible characters, undo the defanging, then let the WHATWG URL parser
// tell us what the host actually is. It already handles userinfo, ports,
// backslash normalisation and IDN -> punycode conversion correctly, which is
// exactly the set of things hand-rolled regexes get wrong.

const { getDb } = require('./database');

// ── Invisible / direction-control characters ────────────────────────
// Zero-width spaces, joiners, word joiners, BOM, and the bidi overrides.
// These render as nothing but break naive substring matching, and Haven
// already uses ​ deliberately elsewhere (the @everyone stripper in
// messages.js), so we can assume attackers know the trick works here.
// Written as escapes on purpose: these characters are invisible in an editor,
// so a literal character class here would be unreadable and impossible to
// review or safely edit later.
const INVISIBLE_RE = new RegExp(
  '[' +
  '\\u00AD' +              // soft hyphen
  '\\u180E' +              // Mongolian vowel separator
  '\\u200B-\\u200F' +      // zero-width space/joiners, LTR/RTL marks
  '\\u202A-\\u202E' +      // bidi embedding / override
  '\\u2060-\\u2064' +      // word joiner, invisible operators
  '\\u206A-\\u206F' +      // deprecated formatting
  '\\uFEFF' +              // BOM / zero-width no-break space
  ']', 'g'
);

// ── Common web TLDs ─────────────────────────────────────────────────
// Only consulted for schemeless candidates. Haven's client only auto-links
// http(s):// URLs (see the linkifier in app-utilities.js), so a bare
// "evil.foo" is inert text nobody can click. We still want to catch bare
// domains that a human would retype, without flagging every "readme.md",
// "script.py" or "v3.41.0" in a technical conversation — several file
// extensions collide with real ccTLDs, so a permissive rule here would
// block ordinary messages. Curated list keeps false positives near zero.
const COMMON_TLDS = new Set([
  'com', 'net', 'org', 'io', 'co', 'gg', 'tv', 'me', 'app', 'dev', 'gov', 'edu',
  'info', 'biz', 'xyz', 'online', 'site', 'shop', 'store', 'live', 'link', 'click',
  'top', 'fun', 'icu', 'cyou', 'rest', 'cfd', 'sbs', 'lol', 'zip', 'mov', 'download',
  'uk', 'de', 'fr', 'nl', 'ru', 'cn', 'jp', 'br', 'au', 'ca', 'us', 'eu', 'ch', 'se',
  'no', 'fi', 'dk', 'pl', 'es', 'it', 'pt', 'ie', 'nz', 'za', 'in', 'mx', 'ar', 'kr'
]);

// Hosts that are never a legitimate target for a posted link. Bare IPs are
// handled separately (they have no domain to allowlist against).
const NEVER_ALLOWED_HOSTS = new Set([
  'localhost', 'localhost.localdomain', '127.0.0.1', '0.0.0.0', '[::1]', '::1'
]);

// ── Settings cache ──────────────────────────────────────────────────
// Hit on every message, so we cache like the IP-ban gate does and let the
// admin handlers invalidate on write.
let _cache = { settings: null, allow: null, deny: null, expires: 0 };
const CACHE_MS = 15000;

function invalidate() { _cache.expires = 0; }

const DEFAULTS = {
  automod_enabled: 'false',
  automod_link_mode: 'off',                 // 'off' | 'allowlist' | 'blocklist'
  automod_link_exempt_level: '50',          // effective level at/above which links are never filtered
  automod_link_min_account_hours: '0',      // accounts younger than this can post no links at all
  automod_scan_edits: 'true',
  automod_scan_profile: 'true',
  automod_scan_dms: 'true',
  automod_block_ip_urls: 'true',            // http://192.0.2.1/... is never a friendly link
  automod_block_punycode: 'true',           // non-allowlisted xn-- hosts (homoglyph domains)
  automod_block_obfuscated: 'true',         // hxxp:// and evil[.]com defanging
  automod_preview_allowlist_only: 'true',   // only unfurl/inline-render allowlisted hosts
  automod_escalation: JSON.stringify({
    windowHours: 24, warnAt: 1, muteAt: 3, muteMinutes: 60, banAt: 5
  }),
  automod_ban_ip: 'false',                  // escalated bans also ban the offender's recent IPs
  automod_log_channel: ''                   // channel code to mirror automod actions into
};

function settings() {
  const now = Date.now();
  if (_cache.settings && now < _cache.expires) return _cache.settings;

  const s = Object.assign({}, DEFAULTS);
  try {
    const rows = getDb().prepare(
      "SELECT key, value FROM server_settings WHERE key LIKE 'automod_%'"
    ).all();
    for (const r of rows) s[r.key] = r.value;
  } catch { /* pre-migration DB: fall back to defaults (all off) */ }

  let allow = new Map(), deny = new Map();
  try {
    for (const r of getDb().prepare('SELECT domain, mode, include_subdomains FROM automod_domains').all()) {
      (r.mode === 'deny' ? deny : allow).set(r.domain, r.include_subdomains !== 0);
    }
  } catch { /* table not created yet */ }

  _cache = { settings: s, allow, deny, expires: now + CACHE_MS };
  return s;
}

function enabled() { return settings().automod_enabled === 'true'; }

// ══════════════════════════════════════════════════════════════════════
// Host normalisation and matching
// ══════════════════════════════════════════════════════════════════════

// Reduce a hostname to the form we store and compare against: lowercase,
// no trailing root dot, no leading "www.". The URL parser has already done
// the IDN -> punycode conversion by this point, which is what makes the
// Cyrillic-homoglyph case fall out naturally: "аbout.com" arrives here as
// "xn--bout-8cd.com" and simply is not "about.com", so it cannot match an
// allowlist entry for the real domain.
function normalizeHost(host) {
  if (typeof host !== 'string') return '';
  let h = host.trim().toLowerCase();
  if (!h) return '';
  // Strip brackets from IPv6 literals so they compare consistently.
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  while (h.endsWith('.')) h = h.slice(0, -1);
  if (h.startsWith('www.')) h = h.slice(4);
  return h;
}

// Suffix match with an explicit dot boundary. `endsWith(entry)` alone is the
// classic hole: it happily matches "evilyoutube.com" against "youtube.com".
function hostMatches(host, entry, includeSubdomains) {
  if (host === entry) return true;
  if (!includeSubdomains) return false;
  return host.endsWith('.' + entry);
}

function lookup(host, table) {
  for (const [entry, includeSubs] of table) {
    if (hostMatches(host, entry, includeSubs)) return true;
  }
  return false;
}

function isIpLiteral(host) {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every(o => Number(o) >= 0 && Number(o) <= 255);
  }
  // Anything with two colons or hex-and-colons only is an IPv6 literal.
  return host.includes(':') && /^[0-9a-f:.]+$/.test(host);
}

function hasPunycodeLabel(host) {
  return host.split('.').some(l => l.startsWith('xn--'));
}

// Public: is this host allowed to be linked / previewed / inline-rendered?
// Returns { allowed, reason }.
function checkHost(host) {
  const s = settings();
  const h = normalizeHost(host);
  if (!h) return { allowed: false, reason: 'unparseable host' };

  const mode = s.automod_link_mode;

  // Explicit deny always wins, in either mode.
  if (lookup(h, _cache.deny)) return { allowed: false, reason: 'domain is blocklisted' };

  const onAllowlist = lookup(h, _cache.allow);
  if (onAllowlist) return { allowed: true, reason: '' };

  if (NEVER_ALLOWED_HOSTS.has(h)) return { allowed: false, reason: 'loopback address' };

  if (isIpLiteral(h) && s.automod_block_ip_urls === 'true') {
    return { allowed: false, reason: 'links to a raw IP address are not allowed' };
  }

  // A punycode host that is not explicitly allowlisted is a strong signal:
  // legitimate IDN domains do exist, but in a chat server the overwhelming
  // majority of xn-- hosts nobody has approved are homoglyph impersonations.
  if (hasPunycodeLabel(h) && s.automod_block_punycode === 'true') {
    return { allowed: false, reason: 'internationalized domain that looks like a lookalike' };
  }

  if (mode === 'allowlist') return { allowed: false, reason: 'domain is not on the allowlist' };
  return { allowed: true, reason: '' };
}

// ══════════════════════════════════════════════════════════════════════
// URL extraction
// ══════════════════════════════════════════════════════════════════════

// Undo the common "defanging" conventions people use to write a hostile URL
// without making it clickable. Attackers use the same syntax to slip past
// filters that only look for "http", so we normalise before extracting and
// remember that we had to.
function deobfuscate(text) {
  let changed = false;
  let out = text;

  const before = out;
  out = out
    .replace(/\bh(?:xx|XX|\*\*)p(s?)\b/gi, 'http$1')
    .replace(/\bhttp(s?)\s*:\s*\/\s*\//gi, 'http$1://')
    .replace(/[\[({<]\s*(?:\.|dot|DOT)\s*[\])}>]/g, '.')
    .replace(/\s+(?:\[dot\]|\(dot\)|dot)\s+/gi, '.')
    .replace(/[\[({<]\s*(?::|colon)\s*[\])}>]/gi, ':');
  if (out !== before) changed = true;

  return { text: out, obfuscated: changed };
}

// Pull every candidate URL out of a block of text.
//
// Returns [{ raw, host, url, viaMarkdown, label, obfuscated }]. `host` is the
// normalised hostname the browser would actually connect to, which is the
// only thing worth making a policy decision about.
function extractUrls(rawText) {
  if (typeof rawText !== 'string' || !rawText) return [];

  // 1. Drop invisible characters so they cannot split a hostname.
  const stripped = rawText.replace(INVISIBLE_RE, '');
  // 2. Undo defanging.
  const { text, obfuscated } = deobfuscate(stripped);

  const found = [];
  const seen = new Set();

  const push = (candidate, opts = {}) => {
    if (!candidate) return;
    let u;
    try {
      // Give schemeless candidates a scheme so the parser will accept them.
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) ? candidate : 'http://' + candidate);
    } catch { return; }

    // Only web-ish schemes can leak an IP or drop a file. javascript:, data:
    // and mailto: are handled by the sanitizer / client escaping, not here.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;

    const host = normalizeHost(u.hostname);
    if (!host || !host.includes('.') && !isIpLiteral(host) && host !== 'localhost') return;

    const key = host + '|' + (opts.label || '');
    if (seen.has(key)) return;
    seen.add(key);

    found.push({
      raw: candidate,
      host,
      url: u.href,
      viaMarkdown: !!opts.viaMarkdown,
      label: opts.label || '',
      obfuscated: obfuscated || !!opts.obfuscated
    });
  };

  // ── Markdown links and images ──
  // Both the label and the target matter. The label is what the reader sees,
  // so `[youtube.com](https://evil.com)` needs the target checked for policy
  // and the mismatch surfaced separately.
  const MD_RE = /!?\[([^\]]*)\]\(\s*([^\s)]+)\s*\)/g;
  let m;
  while ((m = MD_RE.exec(text)) !== null) {
    push(m[2], { viaMarkdown: true, label: m[1] });
  }
  const withoutMd = text.replace(MD_RE, ' ');

  // ── Scheme-ful URLs ──
  // These are the ones Haven's client turns into clickable anchors and
  // inline <img> tags, so they carry all the real risk.
  const SCHEME_RE = /\bhttps?:\/\/[^\s<>"'`\])]+/gi;
  while ((m = SCHEME_RE.exec(withoutMd)) !== null) {
    push(m[0].replace(/[.,;:!?]+$/, ''));
  }
  const withoutScheme = withoutMd.replace(SCHEME_RE, ' ');

  // ── Bare domains ──
  // Restricted to the curated TLD list, otherwise ordinary chat about
  // "readme.md" or "main.py" would trip the filter.
  const BARE_RE = /\b((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,24}))(?::\d{1,5})?(\/[^\s<>"'`)]*)?/gi;
  while ((m = BARE_RE.exec(withoutScheme)) !== null) {
    const tld = m[2].toLowerCase();
    // A path makes intent obvious even on an unusual TLD.
    if (!COMMON_TLDS.has(tld) && !m[3]) continue;
    push(m[0].replace(/[.,;:!?]+$/, ''));
  }

  return found;
}

// Does a markdown label claim to be a different domain than the target?
// Purely a display-deception signal; the target is what gets policy-checked.
function labelLiesAboutTarget(link) {
  if (!link.viaMarkdown || !link.label) return false;
  const labelLinks = extractUrls(link.label);
  if (!labelLinks.length) return false;
  return labelLinks.some(l => l.host !== link.host);
}

// ══════════════════════════════════════════════════════════════════════
// Content check
// ══════════════════════════════════════════════════════════════════════

// ctx: { userId, isAdmin, effectiveLevel, createdAt, surface }
// surface is one of 'message' | 'edit' | 'dm' | 'profile' | 'channel'.
//
// Returns { ok: true } or { ok: false, rule, message, host, excerpt }.
function checkText(text, ctx = {}) {
  if (!enabled()) return { ok: true };
  if (typeof text !== 'string' || !text.trim()) return { ok: true };

  const s = settings();

  if (ctx.surface === 'edit' && s.automod_scan_edits !== 'true') return { ok: true };
  if (ctx.surface === 'dm' && s.automod_scan_dms !== 'true') return { ok: true };
  if (ctx.surface === 'profile' && s.automod_scan_profile !== 'true') return { ok: true };

  // Admins and sufficiently-ranked staff are never filtered. Checked before
  // anything else so a mod pasting a link into a locked-down channel works.
  if (ctx.isAdmin) return { ok: true };
  const exemptLevel = parseInt(s.automod_link_exempt_level, 10);
  if (Number.isFinite(exemptLevel) && exemptLevel >= 0 &&
      Number.isFinite(ctx.effectiveLevel) && ctx.effectiveLevel >= exemptLevel) {
    return { ok: true };
  }

  const links = extractUrls(text);
  if (!links.length) return { ok: true };

  // ── New-account link gate ──
  // Independent of the allowlist and deliberately blunt. The register ->
  // post-link -> get-banned -> re-register loop is the pattern this exists
  // to break, and it does not care which domain was used.
  const minHours = parseInt(s.automod_link_min_account_hours, 10);
  if (Number.isFinite(minHours) && minHours > 0 && ctx.createdAt) {
    const ageMs = Date.now() - new Date(String(ctx.createdAt).replace(' ', 'T') + 'Z').getTime();
    if (Number.isFinite(ageMs) && ageMs < minHours * 3600 * 1000) {
      const hoursLeft = Math.max(1, Math.ceil((minHours * 3600 * 1000 - ageMs) / 3600000));
      return {
        ok: false,
        rule: 'link_new_account',
        host: links[0].host,
        excerpt: links[0].url.slice(0, 200),
        message: `New accounts can't post links yet. Try again in about ${hoursLeft} hour${hoursLeft === 1 ? '' : 's'}.`
      };
    }
  }

  if (s.automod_link_mode === 'off') return { ok: true };

  for (const link of links) {
    if (link.obfuscated && s.automod_block_obfuscated === 'true' && !lookup(link.host, _cache.allow)) {
      return {
        ok: false,
        rule: 'link_obfuscated',
        host: link.host,
        excerpt: link.raw.slice(0, 200),
        message: 'That link looks deliberately disguised, so it was blocked.'
      };
    }

    const verdict = checkHost(link.host);
    if (!verdict.allowed) {
      return {
        ok: false,
        rule: 'link_blocked',
        host: link.host,
        excerpt: link.url.slice(0, 200),
        message: `Links to ${link.host} aren't allowed here (${verdict.reason}).`
      };
    }

    if (labelLiesAboutTarget(link)) {
      return {
        ok: false,
        rule: 'link_masked',
        host: link.host,
        excerpt: link.url.slice(0, 200),
        message: `That link is labelled as one site but points to ${link.host}, so it was blocked.`
      };
    }
  }

  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════
// Infractions and escalation
// ══════════════════════════════════════════════════════════════════════

function escalationConfig() {
  try {
    const cfg = JSON.parse(settings().automod_escalation);
    return {
      windowHours: Number(cfg.windowHours) > 0 ? Number(cfg.windowHours) : 24,
      warnAt: Number(cfg.warnAt) > 0 ? Number(cfg.warnAt) : 0,
      muteAt: Number(cfg.muteAt) > 0 ? Number(cfg.muteAt) : 0,
      muteMinutes: Number(cfg.muteMinutes) > 0 ? Number(cfg.muteMinutes) : 60,
      banAt: Number(cfg.banAt) > 0 ? Number(cfg.banAt) : 0
    };
  } catch {
    return { windowHours: 24, warnAt: 1, muteAt: 3, muteMinutes: 60, banAt: 5 };
  }
}

// Record the offence and work out what to do about it. Returns
// { count, action, muteMinutes }, where action is 'none' | 'warn' | 'mute' | 'ban'.
//
// The caller performs the mute/ban so that socket disconnection, presence
// updates and audit logging stay in the socket layer where they belong.
function recordInfraction(userId, verdict, channelId) {
  const db = getDb();
  const cfg = escalationConfig();

  try {
    db.prepare(
      'INSERT INTO automod_infractions (user_id, rule, channel_id, host, excerpt) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, verdict.rule, channelId || null, verdict.host || null, (verdict.excerpt || '').slice(0, 300));
  } catch (err) {
    console.error('automod: failed to record infraction', err);
    return { count: 0, action: 'none', muteMinutes: 0 };
  }

  let count = 0;
  try {
    count = db.prepare(
      `SELECT COUNT(*) AS c FROM automod_infractions
       WHERE user_id = ? AND created_at >= datetime('now', ?)`
    ).get(userId, `-${cfg.windowHours} hours`).c;
  } catch { count = 1; }

  // Highest threshold that has been reached wins.
  let action = 'none';
  if (cfg.warnAt && count >= cfg.warnAt) action = 'warn';
  if (cfg.muteAt && count >= cfg.muteAt) action = 'mute';
  if (cfg.banAt && count >= cfg.banAt) action = 'ban';

  return { count, action, muteMinutes: cfg.muteMinutes, windowHours: cfg.windowHours };
}

// ── Preview / inline-render gate ────────────────────────────────────
// Used by /api/link-preview. Separate from checkText because it answers a
// narrower question: may the SERVER fetch this, and may every client in the
// channel be told to load an image from it?
//
// This is the control that closes the passive leak. Haven renders og:image
// and bare image URLs directly from the third-party host in every viewer's
// browser, so a hostile link exposes the IP and User-Agent of everyone who
// merely scrolls past it, with no click involved.
function previewAllowed(url) {
  const s = settings();
  if (!enabled()) return true;
  if (s.automod_preview_allowlist_only !== 'true') return true;
  if (s.automod_link_mode === 'off') return true;

  let host;
  try { host = normalizeHost(new URL(url).hostname); } catch { return false; }
  if (!host) return false;

  if (lookup(host, _cache.deny)) return false;
  if (lookup(host, _cache.allow)) return true;
  // In allowlist mode an unknown host never gets unfurled. In blocklist mode
  // only explicitly denied hosts are held back.
  return s.automod_link_mode !== 'allowlist';
}

module.exports = {
  settings,
  invalidate,
  enabled,
  checkText,
  checkHost,
  previewAllowed,
  extractUrls,
  normalizeHost,
  hostMatches,
  recordInfraction,
  escalationConfig,
  DEFAULTS
};
