/**
 * Upload-tag lookups for the composer's tag picker.
 *
 * Phase 1 exposes a single read: a prefix search over the global upload-tag
 * vocabulary so a user can pick an existing tag. Minting new tags happens on
 * message send (see uploadTags.applyTagsToMessage), not here, so there is no
 * write path in this handler yet.
 *
 * The search fans out to an indexed LIKE, which is cheap, but it is still a DB
 * hit per keystroke, so it gets its own tight per-account flood bucket
 * (`tagSearch`) on top of the shared event budget; the composer also debounces.
 */
const { searchTags, MAX_TAG_LEN } = require('../uploadTags');

module.exports = function register(socket, ctx) {
  const { db, floodCheck } = ctx;

  socket.on('search-upload-tags', (data, cb) => {
    const respond = typeof cb === 'function' ? cb : () => {};
    if (!data || typeof data !== 'object') return respond({ tags: [] });
    const query = typeof data.query === 'string' ? data.query : '';
    if (query.length > MAX_TAG_LEN) return respond({ tags: [] });

    if (floodCheck('tagSearch')) return respond({ error: 'rate_limited', tags: [] });

    try {
      // Empty query browses the whole vocabulary (picker just opened); a typed
      // query narrows by prefix. Both capped inside searchTags.
      respond({ tags: searchTags(db, query, 50) });
    } catch (e) {
      respond({ tags: [] });
    }
  });
};
