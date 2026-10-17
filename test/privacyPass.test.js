'use strict';

// The privacy pass (src/privacyPass.js): telling photos and videos apart
// without the tools, naming files by what they really are, and, where
// exiftool and ffmpeg are installed, actually removing location data.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'haven-privacy-'));
process.env.HAVEN_DATA_DIR = DATA;
process.env.HAVEN_NO_TOOL_DOWNLOAD = '1';
const tools = require('../src/mediaTools');
const pp = require('../src/privacyPass');

test.after(() => {
  tools.stopExiftool();
  fs.rmSync(DATA, { recursive: true, force: true });
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

function write(name, buf) {
  const file = path.join(DATA, name);
  fs.writeFileSync(file, buf);
  return file;
}

function box(type, ...children) {
  const body = Buffer.concat(children.map(c => (typeof c === 'string' ? Buffer.from(c, 'latin1') : c)));
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, body]);
}
const hdlr = (kind) => box('hdlr', Buffer.alloc(8), kind, Buffer.alloc(12));

test('a misleading extension is replaced, a different spelling of the right one is not', () => {
  assert.strictEqual(pp.correctExt('.bin', 'png'), 'png');
  assert.strictEqual(pp.correctExt('', 'jpg'), 'jpg');
  assert.strictEqual(pp.correctExt('.JPEG', 'jpg'), null);
  assert.strictEqual(pp.correctExt('.heif', 'heic'), null);
  assert.strictEqual(pp.correctExt('.mov', 'mov'), null);
  assert.strictEqual(pp.correctExt('.png', ''), null, 'an unknown type renames nothing');
});

test('without the tools, photos and videos are recognised by their bytes', async () => {
  const ftyp = (brand) => box('ftyp', brand, Buffer.alloc(4), brand);
  assert.strictEqual(await pp.sniffMediaKind(write('a', Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(20)]))), 'photo');
  assert.strictEqual(await pp.sniffMediaKind(write('b', PNG)), 'photo');
  assert.strictEqual(await pp.sniffMediaKind(write('c', ftyp('heic'))), 'photo');
  assert.strictEqual(await pp.sniffMediaKind(write('d', Buffer.concat([ftyp('isom'), box('moov', box('trak', hdlr('vide')))]))), 'video');
  assert.strictEqual(await pp.sniffMediaKind(write('e', Buffer.concat([ftyp('M4A '), box('moov', box('trak', hdlr('soun')))]))), null,
    'sound alone in an MP4 (a voice message) is not a video');
  const ebml = (codec) => Buffer.concat([Buffer.from([0x1A, 0x45, 0xDF, 0xA3]), Buffer.alloc(30), Buffer.from([0x86, 0x80 | codec.length]), Buffer.from(codec)]);
  assert.strictEqual(await pp.sniffMediaKind(write('f', ebml('V_VP9'))), 'video');
  assert.strictEqual(await pp.sniffMediaKind(write('g', ebml('A_OPUS'))), null, 'a WebM voice message is not a video');
  assert.strictEqual(await pp.sniffMediaKind(write('h', require('node:crypto').randomBytes(4096))), null, 'encrypted DM files are left alone');
});

const haveTools = tools.locateTools();

test('photos lose their location, XMP and IPTC but keep their rotation', { skip: !haveTools && 'exiftool and ffmpeg are not installed' }, async () => {
  const file = write('photo.bin', PNG);
  await tools.exiftool(['-overwrite_original', '-XMP-exif:GPSLatitude=40.7', '-XMP-exif:GPSLongitude=74', '-XMP-photoshop:City=Somewhere', file]);
  assert.ok((await pp.inspect(file)).dirt.length, 'the test photo starts out with a location');
  const r = await pp.cleanFile(file);
  assert.strictEqual(r.kind, 'photo');
  assert.strictEqual(r.ext, 'png', 'named by what it is, not what it was called');
  assert.deepStrictEqual((await pp.inspect(file)).dirt, []);
});

test('videos lose their location and keep their picture and sound', { skip: !haveTools && 'exiftool and ffmpeg are not installed' }, async () => {
  const file = path.join(DATA, 'clip.mp4');
  const make = spawnSync(tools.toolPath('ffmpeg'), ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=64x48:rate=5',
    '-f', 'lavfi', '-i', 'sine', '-t', '1', '-c:v', 'mpeg4', '-c:a', 'aac', '-metadata', 'location=+40.7000-074.0000/', file]);
  assert.strictEqual(make.status, 0, String(make.stderr));
  assert.ok((await pp.inspect(file, { embedded: true })).dirt.length, 'the test video starts out with a location');
  const r = await pp.cleanFile(file);
  assert.strictEqual(r.kind, 'video');
  assert.deepStrictEqual((await pp.inspect(file, { embedded: true })).dirt, []);
  const probe = spawnSync(tools.toolPath('ffmpeg'), ['-hide_banner', '-i', file], { encoding: 'utf8' });
  assert.match(probe.stderr, /Video:/);
  assert.match(probe.stderr, /Audio:/);
});

test('files that are not photos or videos are left exactly as they were', { skip: !haveTools && 'exiftool and ffmpeg are not installed' }, async () => {
  const text = write('notes.txt', 'nothing to see here');
  assert.deepStrictEqual(await pp.cleanFile(text), { kind: null, ext: null });
  assert.strictEqual(fs.readFileSync(text, 'utf8'), 'nothing to see here');
});
