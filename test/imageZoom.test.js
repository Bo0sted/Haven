'use strict';

// Lightbox zoom (app-image-zoom.js): the point under the cursor stays put,
// the picture cannot be dragged off screen, and the wheel steps stay sane.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const modulePath = path.join(__dirname, '..', 'public', 'js', 'modules', 'app-image-zoom.js');
let M;
test.before(async () => {
  M = (await import(pathToFileURL(modulePath).href)).default;
});

// A 1000x600 picture centred in a 1200x800 viewport.
const G = { cx: 600, cy: 400, w: 1000, h: 600, vw: 1200, vh: 800 };
const FIT = { scale: 1, tx: 0, ty: 0 };
const screenOf = (st, ix, iy) => ({ x: G.cx + st.tx + st.scale * ix, y: G.cy + st.ty + st.scale * iy });
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} vs ${b}`);

test('zooming at a corner keeps that corner under the cursor', () => {
  // Top-left corner of the picture sits at (100, 100) on screen.
  const st = M._izZoomAround(FIT, 3, 100, 100, G);
  assert.equal(st.scale, 3);
  const p = screenOf(st, -500, -300);
  near(p.x, 100);
  near(p.y, 100);
  // And again from there, at a different point.
  const st2 = M._izZoomAround(st, 5, 700, 300, G);
  const ix = (700 - G.cx - st.tx) / st.scale, iy = (300 - G.cy - st.ty) / st.scale;
  const q = screenOf(st2, ix, iy);
  near(q.x, 700);
  near(q.y, 300);
});

test('scale stays between fit and 8x, and fit means no offset', () => {
  assert.equal(M._izZoomAround(FIT, 50, 600, 400, G).scale, 8);
  assert.deepEqual(M._izZoomAround({ scale: 4, tx: 300, ty: -200 }, 0.2, 10, 10, G), FIT);
});

test('a zoomed picture cannot be dragged off screen', () => {
  const st = M._izClamp({ scale: 2, tx: 99999, ty: -99999 }, G);
  // 2000x1200 on screen: the edges stop where they sat at fit, the left one
  // at 100 and the bottom one at 700.
  near(G.cx + st.tx - 1000, 100);
  near(G.cy + st.ty + 600, 700);
  // Smaller than the viewport along an axis: it stays wholly inside.
  const small = { cx: 600, cy: 400, w: 200, h: 100, vw: 1200, vh: 800 };
  const s2 = M._izClamp({ scale: 2, tx: -5000, ty: 5000 }, small);
  near(small.cx + s2.tx - 200, 0);
  near(small.cy + s2.ty + 100, 800);
});

test('wheel steps: one notch is a modest step either way, lines count as pixels', () => {
  const inStep = M._izWheelFactor(-100, 0, false, 800);
  const outStep = M._izWheelFactor(100, 0, false, 800);
  assert.ok(inStep > 1.1 && inStep < 1.4, String(inStep));
  near(inStep * outStep, 1);
  near(M._izWheelFactor(-3, 1, false, 800), M._izWheelFactor(-48, 0, false, 800));
  // A runaway delta is capped.
  near(M._izWheelFactor(-100000, 0, false, 800), M._izWheelFactor(-200, 0, false, 800));
});

test('a sideways swipe steps through the pictures; short or steep ones do not', () => {
  assert.equal(M._izSwipeDir(-120, 10), 1);
  assert.equal(M._izSwipeDir(120, -20), -1);
  assert.equal(M._izSwipeDir(-40, 0), 0);
  assert.equal(M._izSwipeDir(-100, 90), 0);
  assert.equal(M._izSwipeDir(0, 300), 0);
});
