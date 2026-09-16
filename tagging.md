# Upload Tagging — Working Notes

> **For AI agents:** This file is the source of truth for the upload-tagging feature across sessions. Read it before touching tag code. Keep entries terse. Update it after a milestone or a decision, not every message (the user wants this economical). Verify file:line citations against current code before relying on them; they drift.

Branch: `tagging` (off `main`). Started 2026-09-16.

## Goal
Let users attach optional tags to file/image uploads, then find those files fast. A global, server-wide tag vocabulary (not per-channel), applied to attachments at send time, searchable from the search bar. Distinct from the pre-existing forum-topic tags (`channels.forum_tags` + `messages.tags` JSON), which are a separate per-channel feature that happens to share the word "tag".

Phases:
1. **Compose + store + display** (DONE) — tag UI in the composer, the two tables, the `manage_tags` permission, a rate-limited vocab lookup, and a Tags footer on sent messages.
2. **Search** (DONE) — a non-strict `tag:` prefix token, a dropdown picker, and clickable message/result tag chips that run a tag search.
3. **Gallery + filters** (LATER) — surface tags in the channel media gallery and let it filter by tag.
4. **Admin settings** (LATER) — make the two hardcoded limits admin-configurable.

## Run locally
Environment-specific to the current dev box; adjust paths on another machine. This box has no `node` on PATH, only a vendored one, and the demo server data lives in `~/.haven` (admin login admin/admin, its own DB, already seeded).

```
export PATH="$PWD/.local-node/node-v22.23.2-linux-x64/bin:$PATH"
FORCE_HTTP=true PORT=3000 node server.js
```

`FORCE_HTTP=true` lets a local browser load it over plain http. Server changes need a restart (no hot reload); client changes need a hard refresh. Run the tests with `node --test --test-concurrency=1` (expect 306 pass / 11 fail: the 11 are pre-existing, unrelated to tagging). Inspect stored tags directly:
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

## Phase 3 — gallery + filters — PLAN (rough)
- Surface tags in the channel media gallery (the photos/videos/files browser in `messages.js` ~604 that regex-parses content). Join `attachment_tags` there.
- Let the gallery filter by tag.
- This is also the natural home for **re-tagging already-sent attachments** (deferred from Phase 1): an edit path guarded by `manage_tags`, writing/removing `attachment_tags` rows on existing messages, broadcast so clients update.

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
- **Tag rendering is display-only** in Phase 1; clicking a tag chip does nothing yet (could deep-link to a `tag:` search in Phase 2/3).
- **Orphan vocabulary:** by design tags persist even if every attachment using them is deleted. A cleanup/merge tool is a Phase 4 nicety, not a requirement.

## Files touched (Phase 1)
Server: `src/uploadTags.js` (new), `src/socketHandlers/tags.js` (new), `src/database.js`, `src/socketHandlers/helpers.js`, `src/socketHandlers/index.js`, `src/socketHandlers/messages.js`.
Client: `public/app.html`, `public/js/modules/app-media.js`, `public/js/modules/app-ui.js`, `public/js/modules/app-admin.js`, `public/js/modules/app-messages.js`, `public/locales/en.json`, `public/css/style.css`.

## Done
- Agreed the model and all Phase 1 design decisions with the user.
- Built Phase 1 (compose + store + display), verified via unit-level DB tests + static checks + clean boot.
- Added the "Add tag" popup browse-all-on-open behavior and the message Tags footer as a follow-up within Phase 1.
- Built Phase 2 (non-strict `tag:` prefix search, filter-popover picker, clickable message/result tag chips, tags on search results). Locked the soft-delete decision for Phase 4. Verified via DB tests + static checks + clean boot.
- **Phases 1 and 2 committed together as `ace5d00`** on branch `tagging` ("still work in progress"). Not pushed. Nothing after that commit is committed yet.
- Phases 3 and 4 not started.
