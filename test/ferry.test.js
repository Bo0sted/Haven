'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  resolveFerryTarget,
  sanitizeWebhookUsername,
  buildHavenContent,
  discordAvatarUrl,
} = require('../src/ferry');

// Two pairings on one Haven channel, one of them sharing a channel name with
// the other so the guild-qualified form is the only way to tell them apart.
const LINKS = [
  { id: 1, guild_name: 'My Server',    discord_channel_name: 'general', out_mode: 'command' },
  { id: 2, guild_name: 'Other Server', discord_channel_name: 'general', out_mode: 'all' },
  { id: 3, guild_name: 'My Server',    discord_channel_name: 'dev',     out_mode: 'command' },
];

const base = { trigger: '=>', links: LINKS, allowDms: false, dmUserId: null };

test('a message with no trigger is not addressed', () => {
  assert.equal(resolveFerryTarget({ ...base, content: 'just talking' }), null);
  // A lone ">" is Haven's blockquote marker and must not be mistaken for one.
  assert.equal(resolveFerryTarget({ ...base, content: '> quoted text' }), null);
});

test('guild-qualified target resolves and is stripped from the body', () => {
  const r = resolveFerryTarget({ ...base, content: '=>My Server#general hello there' });
  assert.equal(r.link.id, 1);
  assert.equal(r.body, 'hello there');
});

test('a guild name containing spaces matches in full', () => {
  const r = resolveFerryTarget({ ...base, content: '=>Other Server#general hi' });
  assert.equal(r.link.id, 2);
  assert.equal(r.body, 'hi');
});

test('the bare #channel form resolves when it is unambiguous', () => {
  const r = resolveFerryTarget({ ...base, content: '=>#dev shipping now' });
  assert.equal(r.link.id, 3);
  assert.equal(r.body, 'shipping now');
});

test('longest label wins, so the qualified form is never shadowed', () => {
  // "#general" is also a valid label, but "Other Server#general" is longer and
  // must be preferred or the message would silently go to the wrong server.
  const r = resolveFerryTarget({ ...base, content: '=>Other Server#general x' });
  assert.equal(r.link.id, 2);
});

test('matching is case insensitive but the body keeps its original case', () => {
  const r = resolveFerryTarget({ ...base, content: '=>my server#GENERAL Hello World' });
  assert.equal(r.link.id, 1);
  assert.equal(r.body, 'Hello World');
});

test('an unknown target does not resolve, so the prefix stays visible', () => {
  assert.equal(resolveFerryTarget({ ...base, content: '=>Nope#nowhere hi' }), null);
});

test('a target with no message body resolves to an empty body', () => {
  const r = resolveFerryTarget({ ...base, content: '=>My Server#dev' });
  assert.equal(r.link.id, 3);
  assert.equal(r.body, '');
});

test('a partial target does not resolve', () => {
  // "=>My Serv" is mid-autocomplete, not a destination.
  assert.equal(resolveFerryTarget({ ...base, content: '=>My Serv hello' }), null);
});

test('DMs need both the server setting and a resolved Discord user id', () => {
  const content = '=>@Alice hey';
  assert.equal(resolveFerryTarget({ ...base, content }), null, 'DMs off');
  assert.equal(resolveFerryTarget({ ...base, allowDms: true, content }), null, 'no user id');

  const r = resolveFerryTarget({ ...base, allowDms: true, dmUserId: '123456789012345678', content });
  assert.equal(r.dm, true);
  assert.equal(r.discordUserId, '123456789012345678');
  assert.equal(r.body, 'hey');
});

test('a custom trigger is honored and the default is not', () => {
  const custom = { ...base, trigger: '>>' };
  assert.equal(resolveFerryTarget({ ...custom, content: '=>My Server#dev hi' }), null);
  assert.equal(resolveFerryTarget({ ...custom, content: '>>My Server#dev hi' }).link.id, 3);
});

test('webhook usernames are repaired rather than rejected by Discord', () => {
  // Discord 400s on webhook usernames containing "discord" or "clyde", which
  // would fail the whole send rather than just the name.
  assert.doesNotMatch(sanitizeWebhookUsername('discord fan'), /discord/i);
  assert.doesNotMatch(sanitizeWebhookUsername('CLYDE'), /clyde/i);
  // Newlines would break out of the JSON field's intent; length is capped at 80.
  assert.doesNotMatch(sanitizeWebhookUsername('two\nlines'), /\n/);
  assert.equal(sanitizeWebhookUsername('x'.repeat(200)).length, 80);
  assert.equal(sanitizeWebhookUsername(''), 'Haven user');
  assert.equal(sanitizeWebhookUsername(null), 'Haven user');
});

test('inbound Discord messages flatten text, attachments and stickers', () => {
  assert.equal(buildHavenContent({ content: 'hello' }), 'hello');

  const withFile = buildHavenContent({
    content: 'look',
    attachments: [{ url: 'https://cdn.discordapp.com/a.png' }],
  });
  assert.equal(withFile, 'look\nhttps://cdn.discordapp.com/a.png');

  // An attachment-only message must still relay something.
  assert.equal(
    buildHavenContent({ content: '', attachments: [{ url: 'https://cdn.discordapp.com/b.png' }] }),
    'https://cdn.discordapp.com/b.png'
  );

  // A link-only message arrives with an empty body and one embed.
  assert.match(
    buildHavenContent({ content: '', embeds: [{ title: 'A page', url: 'https://example.com' }] }),
    /A page/
  );

  // Nothing to say means nothing is relayed, rather than an empty row.
  assert.equal(buildHavenContent({ content: '   ' }), '');
});

test('avatar URLs cover custom, animated, and both default schemes', () => {
  assert.match(
    discordAvatarUrl({ id: '80351110224678912', avatar: 'abc123' }),
    /avatars\/80351110224678912\/abc123\.png/
  );
  assert.match(
    discordAvatarUrl({ id: '80351110224678912', avatar: 'a_abc123' }),
    /\.gif/,
    'animated avatars must keep their extension or Discord serves a still'
  );
  // Post-migration accounts (discriminator "0") index by id, legacy ones by
  // discriminator. Getting this wrong yields a 404 image, not an error.
  assert.match(discordAvatarUrl({ id: '80351110224678912', discriminator: '0' }), /embed\/avatars\/[0-5]\.png/);
  assert.match(discordAvatarUrl({ id: '80351110224678912', discriminator: '1234' }), /embed\/avatars\/[0-4]\.png/);
  assert.equal(discordAvatarUrl(null), null);
});
