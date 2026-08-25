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
},

// Which context the open channel belongs to.
_searchContextKey() {
  const ch = (this.channels || []).find(c => c.code === this.currentChannel);
  return ch && ch.is_dm ? `dm:${this.currentChannel}` : '__public__';
},

// ── State accessors (single entry point so invalidation stays clean) ──
_searchGetState(key) { return this._searchState[key] || null; },
_searchSetState(key, patch) {
  this._searchState[key] = { ...(this._searchState[key] || { open: false, query: '', results: [], page: 1, scrollTop: 0, stale: false }), ...patch };
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
},

// Kick off a query for the current context. Public channels hit the server
// (global FTS, one page at a time); DMs walk the local decrypted cache.
_searchRun(query, page = 1) {
  const key = this._searchContextKey();
  this._searchSetState(key, { open: true, query, stale: false });
  const ch = (this.channels || []).find(c => c.code === this.currentChannel);
  if (ch && ch.is_dm) {
    this._searchDmCacheLocally(query);
  } else {
    this.socket.emit('search-messages', { code: this.currentChannel, query, page });
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
    this.socket.emit('search-messages', { code: this.currentChannel, query: st.query, page: next });
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
    if (st.filters.from) tags.push(`<span class="search-filter-tag">from:${this._escapeHtml(st.filters.from)}</span>`);
    if (st.filters.in)   tags.push(`<span class="search-filter-tag">in:#${this._escapeHtml(st.filters.in)}</span>`);
    if (st.filters.has)  tags.push(`<span class="search-filter-tag">has:${this._escapeHtml(st.filters.has)}</span>`);
    if (tags.length) filterInfo = `<div class="search-filter-tags">${tags.join(' ')}</div>`;
  }
  const localTag = st.isDM ? ' <span class="search-filter-tag">DM (local)</span>' : '';
  count.innerHTML = `${total} result${total === 1 ? '' : 's'} for "${qHtml}"${localTag}${filterInfo}`;

  // Highlight the plain text (filters stripped).
  const highlightQuery = (st.query || '').replace(/\b(?:from|in|has):\S+/gi, '').trim();

  list.innerHTML = total === 0
    ? `<p class="muted-text" style="padding:12px">${t('header.search_no_results')}</p>`
    : pageRows.map(r => `
        <div class="search-result-item" data-msg-id="${r.id}">
          <span class="search-result-author" style="color:${this._getUserColor(r.username)}">${this._escapeHtml(this._getNickname(r.user_id, r.username))}</span>
          <span class="search-result-time">${this._formatTime(r.created_at)}</span>
          <div class="search-result-content">${highlightQuery ? this._highlightSearch(this._escapeHtml(r.content), highlightQuery) : this._escapeHtml(r.content)}</div>
        </div>`).join('');

  list.querySelectorAll('.search-result-item').forEach(item => {
    item.addEventListener('click', () => {
      const msgId = parseInt(item.dataset.msgId, 10);
      this._jumpToMessage(msgId);
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
