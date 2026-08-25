// ── Search panel (overhaul phase 1: look-and-feel) ──────────────────────────
// Discord-style search results overlay that sits over the right sidebar
// (voice + member list). The panel persists across channel switches: it only
// truly closes when the user clicks the X. Every navigation just hides/shows
// it, keeping per-context state (open flag, query, results, page, scroll).
//
// Contexts are keyed so public channels share one panel while each DM keeps
// its own independent one:
//   '__public__'   → shared across all non-DM channels (search is/will be global)
//   'dm:<code>'    → one per DM channel
//
// This phase does NOT change how search queries run. Server search still emits
// `search-messages` and DM search is still the client-side cache walk. Results
// just land in this panel via _searchReceiveResults(). Pagination is real UI
// but slices client-side over whatever the query already returned; phase 2
// swaps the slice for a server LIMIT/OFFSET page fetch. See search-overhaul.md.

const SEARCH_PAGE_SIZE = 25;
// has: options the server understands. Seeded here so adding one is a one-liner.
const SEARCH_HAS_OPTIONS = ['image', 'file', 'link', 'video', 'audio'];

export default {

_searchInit() {
  // Per-context view state. null = never opened / fully closed.
  //   { open, query, results, page, scrollTop, stale }
  this._searchState = Object.create(null);
  // Signature of the channel set we last saw, so a plain reconnect that
  // re-pushes an identical `channels-list` doesn't spuriously mark results
  // stale. Only a real membership/role change invalidates.
  this._searchChannelSig = null;

  const panel = document.getElementById('search-panel');
  if (!panel) return;

  document.getElementById('search-panel-close')?.addEventListener('click', () => this._searchClose());
  document.getElementById('search-page-prev')?.addEventListener('click', () => this._searchGoToPage(-1));
  document.getElementById('search-page-next')?.addEventListener('click', () => this._searchGoToPage(1));
  document.getElementById('search-rerun-btn')?.addEventListener('click', () => this._searchRerun());

  // Remember scroll position within the current context as the user scrolls,
  // so returning to this context restores the exact spot.
  document.getElementById('search-panel-list')?.addEventListener('scroll', (e) => {
    const st = this._searchState[this._searchContextKey()];
    if (st) st.scrollTop = e.target.scrollTop;
  });

  this._searchFilterInit();
},

// Which context the open channel belongs to.
_searchContextKey() {
  const ch = (this.channels || []).find(c => c.code === this.currentChannel);
  return ch && ch.is_dm ? `dm:${this.currentChannel}` : '__public__';
},

// ── State accessors (single entry point so invalidation stays clean) ──
_searchGetState(key) { return this._searchState[key] || null; },
_searchSetState(key, patch) {
  this._searchState[key] = { ...(this._searchState[key] || { open: false, query: '', results: [], page: 1, scrollTop: 0, stale: false, sort: 'newest' }), ...patch };
  return this._searchState[key];
},
_searchClearContext(key) { delete this._searchState[key]; },
// The invalidation entry point wired to `channels-list` (see _searchInvalidate).
// clearAll() will also back live ban/kick handling in phase 2.
_searchClearAll() { this._searchState = Object.create(null); },

// ── Toggle from the header 🔍 button ──
_searchToggle() {
  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  if (st && st.open) {
    this._searchClose();
  } else {
    this._searchSetState(key, { open: true });
    const sc = document.getElementById('search-container');
    if (sc) sc.style.display = 'flex';
    const input = document.getElementById('search-input');
    if (input) { input.value = st?.query || ''; input.focus(); }
    this._searchRenderPanel();
    this._sfpSync();
  }
},

// User-initiated close (the only real close).
_searchClose() {
  const key = this._searchContextKey();
  this._searchClearContext(key);
  document.getElementById('search-panel').style.display = 'none';
  this._searchRestoreSidebar();
  const sc = document.getElementById('search-container');
  if (sc) sc.style.display = 'none';
  const input = document.getElementById('search-input');
  if (input) input.value = '';
  const pop = document.getElementById('search-filter-popover');
  if (pop) pop.style.display = 'none';
},

// Kick off a query for the current context. Public channels hit the server
// (global FTS, one page at a time); DMs walk the local decrypted cache.
_searchRun(query, page = 1) {
  const key = this._searchContextKey();
  const st = this._searchSetState(key, { open: true, query, stale: false });
  const ch = (this.channels || []).find(c => c.code === this.currentChannel);
  if (ch && ch.is_dm) {
    this._searchDmCacheLocally(query);
  } else {
    this.socket.emit('search-messages', { code: this.currentChannel, query, page, sort: st.sort || 'newest' });
  }
},

// Results arrive here from the socket handler (public: server-paged, so
// `results` is one page and `total` is the full count) and from DM local
// search (`results` is the full match set, sliced client-side).
_searchReceiveResults(key, { results, total, page, query, filters, isDM } = {}) {
  const serverPaged = key === '__public__';
  this._searchSetState(key, {
    open: true,
    query: query != null ? query : (this._searchGetState(key)?.query || ''),
    results: results || [],
    filters: filters || null,
    isDM: !!isDM,
    serverPaged,
    total: serverPaged ? (total || 0) : (results ? results.length : 0),
    page: page || 1,
    scrollTop: 0,
    stale: false,
  });
  // Only paint if this context is the one on screen.
  if (key === this._searchContextKey()) this._searchRenderPanel();
},

// Prev/next pager. Server-paged contexts re-fetch the page; local (DM) ones
// just slice the cached matches and re-render.
_searchGoToPage(delta) {
  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  if (!st) return;
  const total = st.serverPaged ? (st.total || 0) : (st.results?.length || 0);
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  const next = Math.min(pages, Math.max(1, (st.page || 1) + delta));
  if (next === st.page) return;
  if (st.serverPaged) {
    this.socket.emit('search-messages', { code: this.currentChannel, query: st.query, page: next, sort: st.sort || 'newest' });
  } else {
    st.page = next;
    st.scrollTop = 0;
    this._searchRenderPanel();
  }
},

// Re-run the stored query after invalidation (the refresh banner button).
_searchRerun() {
  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  if (st && st.query) this._searchRun(st.query);
},

// Jump to a result's message. Global search spans channels, so switch to the
// message's channel first when it isn't the current one, then jump once its
// history loads (same pattern as the ?channel=&message= deep link).
_searchJumpTo(code, msgId) {
  if (!msgId) return;
  if (code && code !== this.currentChannel) {
    this.switchChannel(code);
    setTimeout(() => this._jumpToMessage(msgId), 600);
  } else {
    this._jumpToMessage(msgId);
  }
},

// Called from switchChannel — hide/show the panel for the new context.
_searchOnChannelSwitch() {
  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  const sc = document.getElementById('search-container');
  const input = document.getElementById('search-input');
  if (st && st.open) {
    if (sc) sc.style.display = 'flex';
    if (input) input.value = st.query || '';
    this._searchRenderPanel();
  } else {
    document.getElementById('search-panel').style.display = 'none';
    this._searchRestoreSidebar();
    if (sc) sc.style.display = 'none';
    if (input) input.value = '';
  }
  // Popover follows the box and only shows for public channels (hidden in DMs).
  this._sfpSync();
},

// channels-list arrived — the user's channel set changing (add/remove) can make
// cached rows outlive their access. Signature-gate it so a plain reconnect that
// re-pushes an identical list doesn't false-trigger, then mark stale.
_searchInvalidate(channels) {
  const sig = (channels || []).map(c => c.code).sort().join(',');
  if (this._searchChannelSig === null) { this._searchChannelSig = sig; return; }
  if (sig === this._searchChannelSig) return;
  this._searchChannelSig = sig;
  this._searchMarkStale();
},

// Force the PUBLIC search context stale regardless of the channel signature.
// Used when the user's channel set or their own roles/permissions change — that
// can revoke access without altering which channels appear in the list, so the
// signature wouldn't catch it. Only the public context is touched: DM search is
// local, E2E, and per-DM, so server roles/channel membership never affect it.
// Re-run rebuilds correctly since the server re-authorizes every query.
// (See search-overhaul.md.)
_searchMarkStale() {
  const st = this._searchState['__public__'];
  if (!st || !st.open || !(st.results?.length || st.query)) return;
  st.stale = true;
  st.results = [];
  // Only repaint if the public panel is the one on screen; if a DM is open the
  // stale banner shows when the user switches back (via _searchOnChannelSwitch).
  if (this._searchContextKey() === '__public__') this._searchRenderPanel();
},

// The panel overlays the right sidebar, so a collapsed sidebar would hide it.
// Temporarily un-collapse it when the panel shows; _searchRestoreSidebar puts
// the user's preference back when it hides. Mobile portrait has no search bar,
// so only the desktop collapse state is handled. (search-overhaul)
_searchEnsureVisible() {
  const rs = document.getElementById('right-sidebar');
  if (rs && rs.classList.contains('collapsed') && !this._searchForcedExpand) {
    this._applySidebarCollapsed?.(false);
    this._searchForcedExpand = true;
  }
},
_searchRestoreSidebar() {
  if (this._searchForcedExpand) {
    this._applySidebarCollapsed?.(localStorage.getItem('haven-sidebar-collapsed') === '1');
    this._searchForcedExpand = false;
  }
},

// ── Filter picker popover (phase 3) ──────────────────────────────────────
// Appears with the search box on public channels. Clicking a filter chip opens
// a client-rendered list (members / channels / has options) with a prefix
// filter; picking one appends its token to the search input and re-runs. Lists
// come from client state only (this._lastOnlineUsers, this.channels) so they
// naturally reflect what the user can see; the server still re-authorizes.
_searchFilterInit() {
  const pop = document.getElementById('search-filter-popover');
  if (!pop) return;
  pop.querySelectorAll('.sfp-chip[data-sfp-filter]').forEach(chip => {
    chip.addEventListener('click', () => {
      const f = chip.dataset.sfpFilter;
      // pinned is a plain boolean — no sub-picker, append straight away.
      if (f === 'pinned') this._sfpAppend('pinned:true');
      else this._sfpOpenPicker(f);
    });
  });
  pop.querySelectorAll('.sfp-sort-btn').forEach(b => {
    b.addEventListener('click', () => this._searchSetSort(b.dataset.sort));
  });
  document.getElementById('sfp-back')?.addEventListener('click', () => this._sfpShowRoot());
  const fbox = document.getElementById('sfp-filter-input');
  fbox?.addEventListener('input', () => this._sfpRenderList(this._sfpActive, fbox.value.trim()));
  document.getElementById('sfp-date-apply')?.addEventListener('click', () => this._sfpApplyDate());
  document.getElementById('sfp-date-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') this._sfpApplyDate();
  });
  // Filter button toggles the popover open/closed (separate from the 🔍 button).
  document.getElementById('search-filter-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const hidden = pop.style.display === 'none' || !pop.style.display;
    if (hidden) { this._sfpShowRoot(); pop.style.display = 'block'; }
    else pop.style.display = 'none';
  });
  // Click outside the search box hides the popover (without closing search).
  document.addEventListener('click', (e) => {
    if (pop.style.display === 'none') return;
    const sc = document.getElementById('search-container');
    const toggle = document.getElementById('search-toggle-btn');
    if (sc && !sc.contains(e.target) && !toggle?.contains(e.target)) pop.style.display = 'none';
  });
},

// Show the popover with the search box, but only for public channels — filters
// don't apply to local DM search.
_sfpSync() {
  const pop = document.getElementById('search-filter-popover');
  if (!pop) return;
  const ch = (this.channels || []).find(c => c.code === this.currentChannel);
  const open = document.getElementById('search-container')?.style.display === 'flex';
  const show = open && !(ch && ch.is_dm);
  const btn = document.getElementById('search-filter-btn');
  if (btn) btn.style.display = show ? '' : 'none';
  if (show) { this._sfpShowRoot(); pop.style.display = 'block'; }
  else pop.style.display = 'none';
},

_sfpShowRoot() {
  document.getElementById('sfp-root').style.display = 'flex';
  document.getElementById('sfp-picker').style.display = 'none';
  this._sfpActive = null;
  this._sfpRenderSort();
},

_sfpOpenPicker(type) {
  this._sfpActive = type;
  document.getElementById('sfp-root').style.display = 'none';
  document.getElementById('sfp-picker').style.display = 'flex';
  const isDate = ['before', 'after', 'during'].includes(type);
  const fbox = document.getElementById('sfp-filter-input');
  const dwrap = document.getElementById('sfp-date-wrap');
  const list = document.getElementById('sfp-list');
  if (isDate) {
    // Date filters take a YYYY-MM-DD value from a native date input, not a list.
    if (fbox) fbox.style.display = 'none';
    if (dwrap) dwrap.style.display = 'flex';
    if (list) list.innerHTML = '';
    const di = document.getElementById('sfp-date-input');
    if (di) { di.value = ''; di.focus(); }
  } else {
    if (fbox) { fbox.style.display = ''; fbox.value = ''; }
    if (dwrap) dwrap.style.display = 'none';
    this._sfpRenderList(type, '');
    fbox?.focus();
  }
},

// Append a date filter (before:/after:/during:) from the date input.
_sfpApplyDate() {
  const di = document.getElementById('sfp-date-input');
  const v = di && di.value;   // native date input already gives YYYY-MM-DD
  if (!v || !this._sfpActive) return;
  this._sfpAppend(`${this._sfpActive}:${v}`);
},

// Sort is a query parameter (not a token). Set it on the public context and
// re-run the current query so results reorder immediately.
_searchSetSort(sort) {
  if (!['newest', 'oldest', 'relevant'].includes(sort)) return;
  const key = this._searchContextKey();
  const st = this._searchGetState(key) || this._searchSetState(key, {});
  st.sort = sort;
  this._sfpRenderSort();
  if (st.query) this._searchRun(st.query, 1);
},

_sfpRenderSort() {
  const st = this._searchGetState(this._searchContextKey());
  const cur = (st && st.sort) || 'newest';
  document.querySelectorAll('#sfp-sort .sfp-sort-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.sort === cur);
  });
},

// Build the entry list for a filter type, prefix-filtered by term. Each entry:
// { label, sub, token }. Dumb startsWith prefix match, no fuzzy search.
_sfpRenderList(type, term) {
  const list = document.getElementById('sfp-list');
  if (!list) return;
  const p = (term || '').toLowerCase();
  let entries = [];

  if (type === 'from') {
    const seen = new Set();
    entries = (this._lastOnlineUsers || [])
      .filter(u => u && u.username && !seen.has(u.username) && seen.add(u.username))
      .map(u => ({ label: this._getNickname(u.id, u.username), sub: '@' + u.username, token: `from:${u.username}`, key: u.username }))
      .filter(e => !p || e.key.toLowerCase().startsWith(p) || e.label.toLowerCase().startsWith(p));
  } else if (type === 'in') {
    entries = (this.channels || [])
      .filter(c => c && !c.is_dm)
      .map(c => ({ label: `#${c.name}`, sub: `(${c.display_code || c.code})`, token: `in:#${c.code}`, key: c.name || '' }))
      .filter(e => !p || e.key.toLowerCase().startsWith(p));
  } else if (type === 'has') {
    entries = SEARCH_HAS_OPTIONS
      .map(h => ({ label: h.charAt(0).toUpperCase() + h.slice(1), sub: `has:${h}`, token: `has:${h}`, key: h }))
      .filter(e => !p || e.key.startsWith(p));
  }

  if (!entries.length) {
    list.innerHTML = `<div class="sfp-empty">${t('header.filter_no_matches')}</div>`;
    return;
  }
  list.innerHTML = entries.slice(0, 100).map(e =>
    `<div class="sfp-item" data-token="${this._escapeHtml(e.token)}">
       <span>${this._escapeHtml(e.label)}</span><span class="sfp-item-sub">${this._escapeHtml(e.sub)}</span>
     </div>`).join('');
  list.querySelectorAll('.sfp-item').forEach(item => {
    item.addEventListener('click', () => this._sfpAppend(item.dataset.token));
  });
},

// Append a filter token to the search input and re-run the search.
_sfpAppend(token) {
  const input = document.getElementById('search-input');
  if (!input) return;
  const base = input.value.replace(/\s+$/, '');
  input.value = (base ? base + ' ' : '') + token + ' ';
  input.focus();
  this._sfpShowRoot();
  this._searchRun(input.value.trim());
},

_searchRenderPanel() {
  const panel = document.getElementById('search-panel');
  const list  = document.getElementById('search-panel-list');
  const count = document.getElementById('search-panel-count');
  const pager = document.getElementById('search-panel-pager');
  const banner = document.getElementById('search-panel-banner');
  if (!panel || !list || !count) return;

  const key = this._searchContextKey();
  const st = this._searchGetState(key);
  if (!st || !st.open) { panel.style.display = 'none'; this._searchRestoreSidebar(); return; }
  panel.style.display = 'flex';
  this._searchEnsureVisible();

  // Stale banner (invalidated by a channels-list change).
  if (st.stale) {
    if (banner) banner.style.display = 'flex';
    list.innerHTML = '';
    count.textContent = '';
    if (pager) pager.style.display = 'none';
    return;
  }
  if (banner) banner.style.display = 'none';

  // Server-paged (public) contexts already hold just the current page and a
  // separate total; local (DM) contexts hold every match and slice here.
  const results = st.results || [];
  const total = st.serverPaged ? (st.total || 0) : results.length;
  const pages = Math.max(1, Math.ceil(total / SEARCH_PAGE_SIZE));
  st.page = Math.min(st.page || 1, pages);
  const start = (st.page - 1) * SEARCH_PAGE_SIZE;
  const pageRows = st.serverPaged ? results : results.slice(start, start + SEARCH_PAGE_SIZE);

  // Header count (+ filter tags for channel searches).
  const qHtml = this._escapeHtml(st.query || '');
  let filterInfo = '';
  if (st.filters) {
    const tags = [];
    if (st.filters.from)   tags.push(`<span class="search-filter-tag">from:${this._escapeHtml(st.filters.from)}</span>`);
    if (st.filters.in)     tags.push(`<span class="search-filter-tag">in:#${this._escapeHtml(st.filters.in)}</span>`);
    if (st.filters.has)    tags.push(`<span class="search-filter-tag">has:${this._escapeHtml(st.filters.has)}</span>`);
    if (st.filters.pinned === 'true') tags.push(`<span class="search-filter-tag">pinned</span>`);
    if (st.filters.after)  tags.push(`<span class="search-filter-tag">after:${this._escapeHtml(st.filters.after)}</span>`);
    if (st.filters.before) tags.push(`<span class="search-filter-tag">before:${this._escapeHtml(st.filters.before)}</span>`);
    if (st.filters.during) tags.push(`<span class="search-filter-tag">during:${this._escapeHtml(st.filters.during)}</span>`);
    if (tags.length) filterInfo = `<div class="search-filter-tags">${tags.join(' ')}</div>`;
  }
  const localTag = st.isDM ? ' <span class="search-filter-tag">DM (local)</span>' : '';
  count.innerHTML = `${total} result${total === 1 ? '' : 's'} for "${qHtml}"${localTag}${filterInfo}`;

  // Highlight the plain text (all filter tokens stripped).
  const highlightQuery = (st.query || '').replace(/\b(?:from|in|has|pinned|before|after|during):\S+/gi, '').trim();

  list.innerHTML = total === 0
    ? `<p class="muted-text" style="padding:12px">${t('header.search_no_results')}</p>`
    : pageRows.map(r => {
        // Channel header per result (public/global search). DM local results
        // have no channel, so it's omitted there.
        const chan = r.channel_code
          ? `<div class="search-result-channel">#${this._escapeHtml(r.channel_name || r.channel_code)} <span class="search-result-channel-code">(${this._escapeHtml(r.channel_code)})</span></div>`
          : '';
        return `
        <div class="search-result-item" data-msg-id="${r.id}" data-channel-code="${this._escapeHtml(r.channel_code || '')}">
          ${chan}
          <span class="search-result-author" style="color:${this._getUserColor(r.username)}">${this._escapeHtml(this._getNickname(r.user_id, r.username))}</span>
          <span class="search-result-time">${this._formatTime(r.created_at)}</span>
          <div class="search-result-content">${highlightQuery ? this._highlightSearch(this._escapeHtml(r.content), highlightQuery) : this._escapeHtml(r.content)}</div>
        </div>`;
      }).join('');

  list.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const msgId = parseInt(item.dataset.msgId, 10);
      this._searchJumpTo(item.dataset.channelCode, msgId);
    });
  });

  // Pager — only when more than one page.
  if (pager) {
    if (pages > 1) {
      pager.style.display = 'flex';
      document.getElementById('search-page-label').textContent = t('header.search_page', { page: st.page, pages }) || `Page ${st.page} of ${pages}`;
      document.getElementById('search-page-prev').disabled = st.page <= 1;
      document.getElementById('search-page-next').disabled = st.page >= pages;
    } else {
      pager.style.display = 'none';
    }
  }

  // Restore scroll spot.
  list.scrollTop = st.scrollTop || 0;
},

};
