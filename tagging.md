# Upload Tagging — Working Notes

> **For AI agents:** This file is the source of truth for the upload-tagging feature across sessions. Read it before touching tag code. Keep entries terse. Update it after a milestone or a decision, not every message (the user wants this economical). Verify file:line citations against current code before relying on them; they drift.

Branch: `tagging` (off `main`). Started 2026-09-16.

## Goal
Let users attach optional tags to file/image uploads, then find those files fast. A global, server-wide tag vocabulary (not per-channel), applied to attachments at send time, searchable from the search bar. Distinct from the pre-existing forum-topic tags (`channels.forum_tags` + `messages.tags` JSON), which are a separate per-channel feature that happens to share the word "tag".

Phases:
1. **Compose + store + display** (DONE) — tag UI in the composer, the two tables, the `manage_tags` permission, a rate-limited vocab lookup, and a Tags footer on sent messages.
2. **Search** (DONE) — a non-strict `tag:` prefix token, a dropdown picker, and clickable message/result tag chips that run a tag search.
3. **Retroactive editing + gallery** (DONE) — retroactive tag editing on already-sent messages (Phase 3a) and the media-gallery tag surfacing/filter/bulk-management (Phase 3b) are both built.
4. **Admin settings** (LATER) — make the two hardcoded limits admin-configurable, and a tag-management view (soft delete).

## Run locally
Environment-specific to the current dev box; adjust paths on another machine. This box has no `node` on PATH, only a vendored one, and the demo server data lives in `~/.haven` (admin login admin/admin, its own DB, already seeded).

```
export PATH="$PWD/.local-node/node-v22.23.2-linux-x64/bin:$PATH"
FORCE_HTTP=true PORT=3000 node server.js
```

`FORCE_HTTP=true` lets a local browser load it over plain http. Server changes need a restart (no hot reload); client changes need a hard refresh. (Heads-up: the `admin/admin` login above is what the seeded `~/.haven` DB *should* have, but a running instance returned 401 in one session — the creds on a given box may differ, so live in-app QA can be login-gated to the user.) Run the tests with `node --test --test-concurrency=1` (expect 306 pass / 11 fail: the 11 are pre-existing, unrelated to tagging). Inspect stored tags directly:
```
sqlite3 ~/.haven/haven.db "SELECT m.id, ut.name FROM attachment_tags at JOIN upload_tags ut ON ut.id=at.tag_id JOIN messages m ON m.id=at.message_id ORDER BY m.id DESC LIMIT 20;"
```

## Decisions (locked with the user)
- **Global vocabulary**, one shared tag list server-wide. Not per-channel.
- **Apply vs create split:** applying an existing tag is open to any uploader; minting a NEW tag needs the `manage_tags` permission. Enforced server-side, not just in the UI.
- **New tags commit on message SEND**, not from the composer. The picker shows a new tag optimistically; the server does a get-or-create by normalized name when the message posts. An abandoned draft leaves no orphan tags. Others cannot see a new tag until the message is sent.
- **Fully separate from forum tags.** New vocabulary table is named `upload_tags` (association `attachment_tags`) so it does not read as the same thing as forum `messages.tags` / `channels.forum_tags`.
- **Phase 1 is upload-time only.** Re-tagging already-sent attachments is deferred (Phase 3 gallery territory).
- **Payload key is `attachmentTags`**, NOT `tags` — `data.tags` on `send-message` is already taken by forum topic tags.
- **Composer tag bar is gated to non-DM, non-forum channels.** DMs are E2E (the server never sees the bytes, so it cannot index a tag); forum channels have their own topic-tag UI in the composer that this would visually collide with.
- **`tag:` search is non-strict (PREFIX match), not exact.** A typed partial like `tag:do` matches `dog`/`dogs`/`doghouse`; the value need not be a confirmed vocabulary tag. Clicking a message tag also runs a prefix search of that tag's name (in practice that is just that tag unless a longer tag shares its prefix). Substring instead of prefix would be a one-line change if wanted broader.
- **Retroactive editing: who can edit whose tags.** Editing tags on your OWN message is always allowed (applying existing tags is open; minting a new one still needs `manage_tags`, same ladder as the composer). Editing SOMEONE ELSE'S message needs `manage_tags` (chosen over `delete_message` so tag curation is not coupled to a destructive moderation power). Admin does everything. One unified editor, gated by permission, not two separate views.
- **The "Edit tags" entry appears on any message with an attachment you can tag**, not only already-tagged ones (so you can add a first tag retroactively). Gate: non-DM, has an upload, and (own OR `manage_tags` OR admin). It is a context-menu entry (shared right-click / ⋯ dots menu), not a toolbar button.
- **Deleting a tag is a SOFT delete (Phase 4).** Removing a tag from the vocabulary must NOT retroactively strip it from attachments, so already-tagged files stay searchable (tag "dog", tag many photos, later delete "dog" -> the photos keep the tag). The managerial phase implements delete as hide-from-picker (keep the row + its `attachment_tags`), never a hard `DELETE`. The schema's `ON DELETE CASCADE` on `attachment_tags.tag_id` stays as a safety net; policy is simply "never hard-delete a used tag".

## Data model
No attachments table exists in Haven: an upload is a `messages` row whose `content` is the URL markdown (`![alt](/uploads/x)` for images, `[file:Name](/uploads/x|size)` for files). One upload is normally its own message, but a message can carry more than one URL. Tags therefore key on `(message_id, rel_path)`.

```sql
CREATE TABLE upload_tags (            -- the vocabulary
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,           -- display form, casing preserved
  name_norm  TEXT NOT NULL UNIQUE,    -- case-folded key for lookup + dedupe
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE attachment_tags (        -- the association
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  rel_path   TEXT NOT NULL,           -- the /uploads/<file> the tag is on
  tag_id     INTEGER NOT NULL REFERENCES upload_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, rel_path, tag_id)
);
CREATE INDEX idx_attachment_tags_tag ON attachment_tags(tag_id);
CREATE INDEX idx_attachment_tags_msg ON attachment_tags(message_id);
```
Tags are deliberately NOT folded into the FTS index (`messages_fts`). That keeps `tag:` a precise structured filter, distinct from body text, matching how `pinned:` already works.

## Limits (hardcoded in Phase 1, become admin settings in Phase 4)
Defaults live in `src/uploadTags.js`, mirrored client-side in `app-media.js` (`_maxTagsPerAttachment`, `_maxTagLen`). Keep the two in sync.
- Max tags per attachment: default **3**, hard ceiling **10** (`MAX_TAGS_PER_ATTACHMENT`, `MAX_TAGS_CEIL`).
- Tag length: default **20**, hard ceiling **50** (`MAX_TAG_LEN`, `MAX_TAG_LEN_CEIL`). 10 was considered and rejected as too tight ("screenshot" is already 10).
- Vocab lookup returns at most 100 rows (empty query browses all, ordered by name; typed query is prefix).

Normalization (`normalizeTagName`): trim, collapse inner whitespace, reject empty / over-length, allow `\p{L}\p{N}` plus space, hyphen, underscore (blocks control chars, punctuation, emoji). Display keeps casing; `name_norm` is `toLocaleLowerCase`.

## Phase 1 — as built (DONE, committed ace5d00)
### Server
- `src/uploadTags.js` (NEW) — constants, `normalizeTagName`, `extractUploadPath` (first `/uploads/...` in content), `searchTags` (empty = browse-all, else prefix; capped), `applyTagsToMessage` (dedupe + cap, get-or-create gated by `canCreate`, `INSERT OR IGNORE` links, one transaction, returns applied names, tolerant).
- `src/database.js` — creates both tables next to `upload_ownership`; adds `manage_tags` to the seeded Server Mod role (fresh DBs only; existing DBs grant it in the role editor, and admins bypass the check anyway).
- `src/socketHandlers/helpers.js` — `manage_tags` added to `VALID_ROLE_PERMS`.
- `src/socketHandlers/tags.js` (NEW) — `search-upload-tags { query }` with ack callback, guarded by the new `tagSearch` flood bucket, returns `[{id,name}]`. No write path (creation is on send).
- `src/socketHandlers/index.js` — registers `registerTags`; adds `tagSearch: { max: 20, windowMs: 10000 }` to `FLOOD_LIMITS`.
- `src/socketHandlers/messages.js` — requires `uploadTags`; on `send-message`, after the insert, calls `applyTagsToMessage` for non-DM uploads and captures the applied names onto the broadcast `message.attachmentTags`; the `get-messages` history handler batch-queries `attachment_tags` per page (deduped per message) and attaches `obj.attachmentTags`.

### Client
- `public/app.html` — `#tag-queue-bar` (label, chips, "Add tag" button, popup with search input + list) directly below `#image-queue-bar` in the main composer.
- `public/js/modules/app-media.js` — the composer logic: `_activeAttachment` tracking, click-to-select on queue items, `_renderTagBar`, `_ensureTagComposerBound` (binds once), `_openTagPopup`/`_closeTagPopup`, debounced `_tagPopupSearch` (250ms) with stale-guard, `_renderTagPopupList` (existing tags, plus a create row for `manage_tags` holders when the typed name is valid and not an exact match), `_applyTagToActive`/`_removeTagFromActive`, `_normalizeTag` (client mirror). Tags ride on the File object as `file._tags`, same trick as `_spoiler`. `_renderImageQueue` gained active highlight (`.is-active`), a tagged indicator (`.has-tags`), and calls `_renderTagBar`.
- `public/js/modules/app-ui.js` — `_uploadImage` send emit includes `attachmentTags` from `file._tags`.
- `public/js/modules/app-admin.js` — `_uploadGeneralFile` send emit includes `attachmentTags`; `manage_tags` added to the client `PERMISSIONS` list and `PERM_LABELS`.
- `public/js/modules/app-messages.js` — `_renderAttachmentTags(tags)` builds the footer (tag icon + "Tags" label + escaped chips, all attachments folded into one deduped list); wired into all three render paths (compact, full, and the compact->full hover promotion, which preserves the existing `.message-tags` node).
- `public/locales/en.json` — new top-level `tags` namespace (EN only; other locales fall back) and `permissions.manage_tags`. Placeholders use double braces `{{n}}` / `{{name}}` (Haven's interpolation format).
- `public/css/style.css` — composer tag bar / chips / popup styles and the `.message-tags` footer styles. Uses theme vars, active ring = `--accent`, tagged underline = `--accent`.

### Verified
- `normalizeTagName` edge cases (emoji/over-length rejected, trim+collapse), dedupe + cap-at-3, `canCreate` gate (non-manage_tags applies existing, drops new), case-insensitive reuse, `rel_path` extraction (file + image markdown), browse-all ordering, prefix narrowing, per-message dedup/grouping — all against an in-memory better-sqlite3 DB.
- Server boots clean on the real `~/.haven` DB; both tables created.
- JS syntax (all touched files), `en.json` parses, i18n keys validate (subset test: EN base, others may lag).
- Full suite: **306 pass / 11 fail**, identical to clean `main` (the 11 are pre-existing: audio/bot/e2e/forum/roles integration tests + one dynamic-key i18n false positive `format_picker.`). Zero regressions.
- NOT done: live authenticated in-app QA (login-gated, on the user's side). Server changes need a restart, client changes a hard refresh.

### Verify manually
Tag an attachment in a normal channel and send; the footer should appear. Reopening "Add tag" lists the vocabulary. Confirm storage:
```
sqlite3 ~/.haven/haven.db "SELECT m.id, ut.name, at.rel_path FROM attachment_tags at JOIN upload_tags ut ON ut.id=at.tag_id JOIN messages m ON m.id=at.message_id ORDER BY m.id DESC LIMIT 20;"
```
Note: messages sent BEFORE this feature have no tags, so only new tagged uploads show a footer.

## Phase 2 — search (`tag:` token) + clickable tags (DONE, committed ace5d00)
The search handler parses filters at `messages.js` (~450) and AND-s SQL conditions onto a channel-scoped, permission-checked query. `tag:` slotted into the same mold.
### Server (`messages.js`)
- Parse: `filters.tag`, captured by `/\btag:"([^"]+)"|\btag:(\S+)/gi` so quoted multi-word values work (`tag:"hello world"`). Added to the `anyFilter` guard so a lone `tag:` is valid.
- Apply: **prefix**, case-folded, index-backed: `m.id IN (SELECT at.message_id FROM attachment_tags at JOIN upload_tags ut ON ut.id=at.tag_id WHERE ut.name_norm LIKE ? ESCAPE '\\')` with `escapeLike(norm.norm) + '%'`. (Non-strict, per the decision above.)
- Results now carry `attachmentTags` (a second batch query on the page's ids, deduped per row) so the Tags footer renders on results too, and its chips are clickable.
- `escapeLike` exported from `src/uploadTags.js`; `normalizeTagName` imported into the handler.
### Client
- `public/app.html` — `tag:` chip added to the filter popover chip row.
- `public/js/modules/app-search.js` — `_searchByTag(name)` opens search and runs exactly that tag; `_tagSearchToken(name)` quotes multi-word tags. `_sfpRenderTagList(term)` is a debounced (250ms) server lookup via `search-upload-tags` (shares the `tagSearch` rate limit); `_sfpRenderList` routes `type==='tag'` to it. Picking appends the quoted token. When a typed query returns no active tag, the list shows a "Search removed tags" button (`.sfp-search-removed`, key `tags.search_removed`) that appends the `tag:` token and runs anyway — a removed (soft-deleted) tag is gone from the picker but its old attachments still match the `tag:` search. Filter-tag badge + highlight-strip strip updated for `tag:` (incl. the quoted form). Result rows render `_renderAttachmentTags`; the row-jump skip-list excludes `.message-tag`.
- `public/js/modules/app-messages.js` — `_renderAttachmentTags` chips are now `<button class="message-tag" data-tag="...">`.
- `public/js/modules/app-ui.js` — a document-level delegated click on `.message-tag[data-tag]` calls `_searchByTag`, so it works on messages, search results, threads and PiP.
- `public/locales/en.json` — `tags.search_for`.
- `public/css/style.css` — `.message-tag` is clickable (cursor, hover fills with `--accent` / `--accent-text`). NOTE: the theme-contract test (`themeContract.test.js`) requires any `--accent` fill to pair with `--accent-text`; do not hardcode `#fff`.
### Verified
- Prefix search (`do`/`dog` -> dog,dogs,doghouse; `dogs` -> dogs; `cat` -> cat), quoted multi-word parse, case-fold — in-memory DB. Full suite 306/11 (baseline, zero regressions). Syntax + en.json + boot clean.
- NOT done: live authenticated in-app QA (user side).
- Inherits channel-scope + the search cache-invalidation model, so tag search is permission-safe with no new access plumbing.

## Phase 3a — retroactive tag editing (DONE, committed 1b06d7f)
Edit the tag set on an already-sent message that carries an upload, from a context-menu entry, with live updates for everyone.
### Server
- `src/uploadTags.js` — refactored the apply loop into `pickTags` (normalize+dedupe+cap) and `linkPickedTags` (resolve/mint/link, caller owns the transaction). `applyTagsToMessage` (additive, send-time) now uses them; NEW `setMessageTags` (replace-semantics: deletes the message's existing `attachment_tags` then relinks, so an empty list clears all). Both exported.
- `src/socketHandlers/messages.js` — NEW `set-message-tags { messageId, tags[] }` handler. Loads the message, requires an upload path, rejects DMs, checks membership, authorizes `isOwn || isAdmin || manage_tags`, sets `canCreate = isAdmin || manage_tags`, calls `setMessageTags`, and broadcasts `message-tags-updated { channelCode, messageId, tags }` to the channel room. Guarded by the new `tagEdit` flood bucket. Imports `setMessageTags` + `extractUploadPath`.
- `src/socketHandlers/index.js` — `tagEdit: { max: 20, windowMs: 10000 }` flood bucket.
### Client
- `public/js/modules/app-messages.js` — context menu (`_showMessageContextMenu`) gains an "Edit tags" (🏷️) item, gated `canEditTags = !isDm && hasAttachment && (isOwn || admin || manage_tags)` where `hasAttachment` = `_getMessageAttachments(msgId).length > 0`. Dispatcher action `edit-tags` opens the editor. NEW editor: `_openMessageTagEditor(msgId, msgEl)` (seeds the working set from the message's footer chips), `_closeMessageTagEditor`, `_msgTagEditorRenderChips`, `_msgTagEditorSearch` (debounced `search-upload-tags`), `_msgTagEditorRenderList` (existing tags + a create row for `manage_tags`), `_msgTagEditorAdd`/`_msgTagEditorRemove`, `_msgTagEditorSave` (emits `set-message-tags` with the full set on every change). NEW `_updateMessageTagsFooter(msgId, tags)` repaints the footer on every rendered copy (`[data-msg-id]`: main list, search results, thread, PiP) and syncs `_lastRenderedMessages`.
- `public/js/modules/app-socket.js` — `message-tags-updated` listener calls `_updateMessageTagsFooter`. Fires cross-channel (users are in all their channel rooms), so search results update wherever shown.
- `public/locales/en.json` — `tags.edit`.
- `public/css/style.css` — `.tag-editor-popup` and friends; reuses `.tag-popup-*` / `.tag-chip*` from Phase 1.
### Notes / edges
- The editor emits the FULL set on each add/remove; the server replaces and broadcasts, so no explicit Save button. Editor popup is body-level, so the footer repaint never disturbs it.
- Non-`manage_tags` users can only pick EXISTING tags (create row hidden), so they cannot introduce unknown names. If one ever submitted only-unknown names the server would drop them (and, because set-semantics clear first, that would empty the set) — the UI prevents this.
- One upload = one message in practice, so message-level editing == attachment-level. Tags key on the first `/uploads/` path (via `extractUploadPath`), consistent with Phase 1.
### Verified
- `setMessageTags` add/remove/clear + unknown-tag-drop for non-creators — in-memory DB. Full suite 306/11 (baseline). Syntax + en.json + boot clean. NOT done: live in-app QA (user side).

## Phase 3b — gallery: tag chips + filter + bulk management (DONE, committed 1b06d7f)
Three additions to the Files & Media gallery: tag chips on each item, a Tags filter, and a bulk Manage-tags action in select mode.
### Decisions (locked with the user)
- **Bulk Manage-tags is gated to `manage_tags` (or admin)** — the curation permission, which also lets it mint tags. Such users can now enter select mode **even without delete rights**; the Delete button stays delete-gated, the Manage-tags dropdown is manage_tags-gated. Server enforces `manage_tags` at the handler.
- **Filter is AND + exact** (not prefix): an item must carry EVERY selected tag, matched case-folded exact. (The picker itself still uses the prefix `search-upload-tags` to *find* tags to select; only the item filtering is exact.) Multiple tags narrow.
- **Confirm-gated apply** (unlike Phase 3a's auto-save): the bulk picker collects a working set and applies only on **Confirm**; clicking away discards.
- **Empty-set semantics:** append with no tags is a no-op; replace with no tags clears every tag on every selected item, and gets a SECOND `_showConfirmModal` warning after Confirm (danger). Server tolerates empty lists (`setMessageTags` clears, `applyTagsToMessage` returns `[]`).
### Server (`messages.js`)
- `get-channel-media` now batch-queries `attachment_tags` for the page's message ids and attaches `entry.tags` (keyed on `message_id|rel_path`; only non-empty). Links never get tags.
- NEW `bulk-tag-messages { code, messageIds[], mode:'append'|'replace', tags[] }` (ack callback). Validates, `tagEdit` flood bucket, membership + DM reject, requires `manage_tags`/admin. Per unique message id: `setMessageTags` (replace) or `applyTagsToMessage` (append), `canCreate:true`; reads back the full set, pushes `{messageId,tags}` into `results`, and broadcasts `message-tags-updated` per message (so open footers repaint live). Returns `{ ok, updated, results }`. Dedupes message ids; skips ids outside the channel or without an upload path.
### Client
- `public/app.html` — a **Tags** filter button (+count badge) next to Sort by; a **Manage tags** dropdown (Append / Replace all) inside `#media-gallery-actions`.
- `public/js/modules/app-ui.js` — `_canManageTags`; toolbar gating in `_refreshMediaGalleryToolbar` (select mode = canDelete OR canManageTags; Delete shown only for deleters; Manage shown only for managers with a selection). `_renderMediaGalleryTab` applies `_filterMediaItemsByTags` (AND/exact, links exempt) with a `filter_no_match` empty state and renders read-only `tileTags` chips on every item. Filter picker: `_openMediaTagFilter`/`_closeMediaTagFilter`/`_mediaTagFilterSearch`/`_mediaTagFilterRenderList` (multi-select toggle + Clear filter row, ✓ on active), `_toggleMediaTagFilter`, `_updateTagFilterBadge`, `_afterTagFilterChange`. Bulk picker: `_openMediaTagManage`/`_closeMediaTagManage` + chips/search/list/add/remove mirroring the message editor but **no auto-save**, plus `_mediaTagManageApply` (emits `bulk-tag-messages`, optimistically updates `_mediaGalleryData` item tags from `results`, keeps selection; replace-empty routes through the danger confirm). `_renderMediaGallery` resets the filter and tears down popups on fresh data.
- `public/locales/en.json` — `media_gallery.filter_tags`, `filter_by_tag`, `filter_clear`, `filter_no_match`, `manage_tags`, `append_tags`, `replace_tags`, `tag_apply_append`, `tag_apply_replace`, `tag_apply_confirm`, `tags_updated`, `tags_update_failed`, `confirm_clear_title`, `confirm_clear_body`, `confirm_clear_ok`.
- `public/css/style.css` — `.media-gallery-tagfilter(-count)`, `#…-tagfilter-btn.is-active`, `.tag-popup-item.is-active`, `.media-gallery-tagmanage` + `.media-tagmanage-menu`/`-opt`, `.tag-manage-actions`, `.media-tile-tags`/`.media-tile-tag`. Reuses `.tag-editor-popup`, `.tag-popup-*`, `.tag-chip*`. **Z-index gotcha:** the shared `.tag-editor-popup` is z-index 1000, but the gallery modal-overlay is 100001, so `#media-tag-filter-popup`/`#media-tag-manage-popup` are bumped to 100002 by id (below the 100002 confirm dialog, which wins on DOM order).
### Notes / edges
- Optimistic post-apply update keys by `message_id` (sets the same tags on every gallery item of that message). Consistent with the "one upload = one message" assumption; a full `get-channel-media` refetch keys precisely by `(message_id, url)` so only the first-path item would carry tags. Rare multi-attachment messages briefly over-show until the next open/refetch.
- Bulk append caps the *incoming* pick at `MAX_TAGS_PER_ATTACHMENT` (3) via `pickTags`; it does not cap the per-attachment *total* (existing + appended), same latent behavior as Phase 1/3a append. Dedup is via `INSERT OR IGNORE`.
### Verified
- JS syntax (all touched files), `en.json` parses, referenced i18n keys resolve. Server boots clean on `~/.haven`.
- Live QA (user side) this session surfaced and fixed three things, all now committed: (1) the filter/manage popups rendered behind the gallery modal — fixed via the z-index bump above; (2) Confirm on append/replace "did nothing" — root cause was a **stale server process** (started before the `messages.js` edit) with no `bulk-tag-messages` handler, fixed by restarting; nothing wrong with the code; (3) the Phase 3a "Edit tags" popup could spawn off-screen for messages at the very bottom — fixed with the flip-above positioner (see Files touched → Phase 3b). Reminder for the next agent: **`src/` changes require a server restart** (no hot reload) or the new socket handlers silently 404 with no ack.
- Remaining: a full fresh-eyes pass of the three fixes together (they were verified individually as they landed).
### Follow-up fixes (uncommitted)
Two gallery-tile polish fixes on top of 3b, in `public/js/modules/app-ui.js` + `public/css/style.css`:
- **Tags never showed on photo/video tiles.** The `.media-tile-tags` div rendered in normal flow after the 100%-height `<img>`, so the tile's `aspect-ratio` + `overflow:hidden` clipped it off-tile. Fix: wrap the tags + date in a `.media-grid-meta` bottom overlay (absolute, `pointer-events:none`, flex-column, gradient moved onto the wrapper). Tags now sit above the date over the image. List tiles (audio/files) were unaffected (their tags are in `.media-list-info` flow) and untouched. Note: the `.media-grid-jump` (↗) button has the same clipping (static, no CSS) and is still not shown — pre-existing, out of scope, left alone.
- **Toolbar buttons taller than the dropdowns.** The `.btn-sm` buttons (Tags, Select, and the select-mode ones) rendered ~4px taller than the adjacent Sort/Size `select`s, so they bulged above the row (every box was already vertically centered — verified live under the cyberpunk theme, all `cy` equal — the buttons were just a different height). Fix: `.media-gallery-toolbar .btn-sm { padding:0.25rem 0.625rem; font-size:0.8rem }` so all toolbar controls share one height (buttons ≈26px, sort select 27px). Verified live: Tags and Select both drop to 26 and line up with the dropdowns.

## Phase 4 — admin settings + tag management — PLAN (rough)
- Swap the hardcoded limits for `server_settings` reads: max tags per attachment (clamp to `MAX_TAGS_CEIL`), tag length (clamp to `MAX_TAG_LEN_CEIL`).
- Surface in the Uploads & Limits admin section (near `max_attachments`, database.js ~437 / the admin UI).
- Client reads them the way `_maxAttachments` already reads `serverSettings`.
- Tag-management view (rename/merge/delete vocabulary entries), gated by `manage_tags`.
  - **Delete is a SOFT delete** (locked decision): hide the tag from the picker and from create-suggestions, but keep the `upload_tags` row and every `attachment_tags` link so old files stay tagged and searchable. Likely add an `active`/`deleted_at` column to `upload_tags`; the composer picker and `searchTags` filter to active, but the `tag:` search filter and the message/gallery footers keep resolving inactive tags so existing associations still match. Never hard-`DELETE` a used tag.

## Technical considerations / limitations
- **E2E DMs are permanently out.** The server never sees DM plaintext, so it cannot store or index a tag for one. Tag bar is hidden there.
- **Forum channels are excluded in the composer** to avoid colliding with the topic-tag UI. Tagging attachments inside forum replies could be revisited later.
- **Multi-word tags + `\S+` filters:** `tag:` search must handle quoting (see Phase 2). Same latent limitation already affects `in:<name>` for multi-word channel names (they recommend `in:#code`).
- **Search results footer:** results do not carry `attachmentTags` yet (different SELECT than history). Wire in Phase 2/3 if wanted.
- **Pre-feature messages** have no tags; only new tagged uploads show footers.
- **Orphan vocabulary:** by design tags persist even if every attachment using them is deleted. A cleanup/merge tool is a Phase 4 nicety, not a requirement.
- **Orphan risk on retro-edit by a non-creator:** `set-message-tags` clears then relinks; a non-`manage_tags` submitter's unknown tags are dropped. The UI prevents submitting unknown names (create row is gated), but keep this in mind if the editor is ever reused elsewhere.

## Files touched
Phase 1: `src/uploadTags.js` (new), `src/socketHandlers/tags.js` (new), `src/database.js`, `src/socketHandlers/helpers.js`, `src/socketHandlers/index.js`, `src/socketHandlers/messages.js`; `public/app.html`, `public/js/modules/app-media.js`, `public/js/modules/app-ui.js`, `public/js/modules/app-admin.js`, `public/js/modules/app-messages.js`, `public/locales/en.json`, `public/css/style.css`.
Phase 2: `src/socketHandlers/messages.js`, `src/uploadTags.js`; `public/app.html`, `public/js/modules/app-search.js`, `public/js/modules/app-messages.js`, `public/js/modules/app-ui.js`, `public/locales/en.json`, `public/css/style.css`.
Phase 3a: `src/uploadTags.js`, `src/socketHandlers/messages.js`, `src/socketHandlers/index.js`; `public/js/modules/app-messages.js`, `public/js/modules/app-socket.js`, `public/locales/en.json`, `public/css/style.css`.
Phase 3b: `src/socketHandlers/messages.js`; `public/app.html`, `public/js/modules/app-ui.js`, `public/locales/en.json`, `public/css/style.css`. (No new server files; reuses `bulk`-style ack + existing `tagEdit` flood bucket.) Also `public/js/modules/app-messages.js` — a follow-up fix to the Phase 3a editor: `_openMessageTagEditor` now calls `_positionMessageTagEditor` (stores `_msgTagEditorAnchor`), which flips the popup ABOVE the message when it would overflow the viewport bottom (messages near the end of the list) and re-runs from `_msgTagEditorRenderList` as the async list height changes.

## Socket events (tagging)
- `search-upload-tags { query } -> { tags:[{id,name}] }` — vocab lookup (composer + both pickers). Flood bucket `tagSearch`.
- `set-message-tags { messageId, tags[] }` — retroactive edit; broadcasts `message-tags-updated`. Flood bucket `tagEdit`.
- `bulk-tag-messages { code, messageIds[], mode, tags[] } -> { ok, updated, results:[{messageId,tags}] }` — gallery bulk append/replace; manage_tags-gated; broadcasts `message-tags-updated` per message. Flood bucket `tagEdit`.
- `channel-media` entries now include `tags[]` (non-empty only) for photos/videos/audios/files.
- `message-tags-updated { channelCode, messageId, tags }` — server -> clients; repaint footers.
- Send-time tags ride on `send-message` as `attachmentTags` (NOT `tags`).

## Commit status
- **Phases 1 and 2 committed as `ace5d00`** (branch `tagging`, "still work in progress"). Then `0205ed8` (doc sync) and `ee1b20f` (run-locally note) touch only `tagging.md`.
- **Phase 3a + Phase 3b committed together as `1b06d7f`** (10 files; message "Retroactive tag editing and gallery tag chips, filter and bulk manage"). This includes the three live-QA fixes and the doc through Phase 3b. 3a and 3b were intentionally combined because they intermix within shared files (`uploadTags.js`, `messages.js`, `en.json`, `style.css`).
- Nothing pushed. At PR time the user wants clean per-phase commits (Phase 1+2 combined is fine); drop the two `tagging.md`-only noise commits (`0205ed8`, `ee1b20f`); `tagging.md` itself can be its own trailing commit or excluded from the PR. Note `1b06d7f` bundles 3a+3b — if strict per-phase history is wanted, it would need an interactive rebase/split, but the user accepted the combined commit.
- **No Co-Authored-By trailer** on tagging commits (user preference); keep it off future ones too.

## Done
- Phases 1 + 2 built and committed (`ace5d00`).
- Phase 3a (retroactive tag editing via context menu, `manage_tags`-gated for others' messages, live footer updates) — committed (`1b06d7f`).
- Phase 3b (gallery: tag chips on items, AND/exact Tags filter, manage_tags-gated bulk Append/Replace in select mode with confirm + replace-empty warning) — committed (`1b06d7f`), plus the three live-QA fixes (popup z-index, bottom-message editor flip, restart clarity).

## Next agent — start here
- Everything through Phase 3b is committed on branch `tagging` (`1b06d7f`). The only tagging change that may be uncommitted is this doc's own next-agent prep (a `tagging.md`-only edit). Any untracked `.claude/`, `.local-node/`, `neutron.theme.css`, `gba_roms/`, `search-overhaul.md`, `themes/neutron/` are UNRELATED — do not commit them.
- Only work left is **Phase 4** (admin-configurable limits + tag-management view with SOFT delete) — see the plan section above; the soft-delete decision is locked.
- Before coding: re-read the Decisions and the Phase 4 plan; verify file:line citations (they drift); restart the server after any `src/` edit.
