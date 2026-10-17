// Zoom and pan for the image lightbox. The mouse wheel and a pinch zoom
// toward the pointer, a drag pans, a double-click or double-tap toggles
// between fit and 2.5x, + - 0 work from the keyboard, and on a touch screen
// a sideways swipe at fit steps to the next or previous picture. Every way of
// opening a picture (chat, threads, the DM pop-out, search, the media
// gallery, profile avatars) shares #image-lightbox, so this one file covers
// them all. app-media.js calls _imageZoomReset whenever the picture changes
// or the lightbox closes.

const MIN_SCALE = 1;
const MAX_SCALE = 8;
const TOGGLE_SCALE = 2.5;
const STEP = 1.5;          // one button or key press
const DRAG_SLOP = 4;       // px a press may wander and still count as a click
const DOUBLE_TAP_MS = 350;
const DOUBLE_TAP_PX = 30;
const SWIPE_PX = 70;

export default {

// Pure: the transform after zooming to `scale` while the screen point
// (px, py) stays where it is. g is the picture's untransformed box (centre
// cx, cy and size w, h) and the viewport size vw, vh.
_izZoomAround(st, scale, px, py, g) {
  const s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const k = s / st.scale;
  return this._izClamp({
    scale: s,
    tx: px - g.cx - k * (px - g.cx - st.tx),
    ty: py - g.cy - k * (py - g.cy - st.ty),
  }, g);
},

// Pure: keep the picture on screen. While it is smaller than the viewport
// along an axis it stays wholly inside; once larger, its edges may come in
// no further than where they sat at fit. So it can never be dragged away,
// and zooming at a point of the picture from fit never has to shift it.
_izClamp(st, g) {
  if (st.scale <= MIN_SCALE + 0.001) return { scale: MIN_SCALE, tx: 0, ty: 0 };
  const axis = (t, c, size, view) => {
    const S = size * st.scale;
    const nearGap = c - size / 2;         // margin before the picture at fit
    const farGap = view - c - size / 2;   // margin after it
    const lo = Math.min(0, view - farGap - S);
    const hi = Math.max(view - S, nearGap);
    const edge = Math.min(hi, Math.max(lo, c + t - S / 2));
    return edge - c + S / 2;
  };
  return {
    scale: st.scale,
    tx: axis(st.tx, g.cx, g.w, g.vw),
    ty: axis(st.ty, g.cy, g.h, g.vh),
  };
},

// Pure: which way a finger swipe at fit steps through the pictures: 1 for
// the next one, -1 for the previous one, 0 when it was too short or too
// steep to count.
_izSwipeDir(dx, dy) {
  if (Math.abs(dx) < SWIPE_PX || Math.abs(dx) < 1.5 * Math.abs(dy)) return 0;
  return dx < 0 ? 1 : -1;
},

// Pure: the zoom factor for one wheel event. Lines and pages become pixels;
// a trackpad pinch arrives as a ctrl+wheel with small deltas, so it gets a
// stronger response.
_izWheelFactor(deltaY, deltaMode, ctrlKey, pageHeight) {
  let dy = deltaY;
  if (deltaMode === 1) dy *= 16;
  else if (deltaMode === 2) dy *= pageHeight;
  dy = Math.max(-200, Math.min(200, dy));
  return Math.exp(-dy * (ctrlKey ? 0.01 : 0.002));
},

_setupImageZoom() {
  const lb = document.getElementById('image-lightbox');
  const img = document.getElementById('lightbox-img');
  if (!lb || !img) return;
  const iz = this._iz = {
    lb, img,
    st: { scale: 1, tx: 0, ty: 0 },
    pointers: new Map(),
    gesture: null,
    lastTap: null,
    eatClickUntil: 0,
    level: document.getElementById('lightbox-zoom-reset'),
    inBtn: document.getElementById('lightbox-zoom-in'),
    outBtn: document.getElementById('lightbox-zoom-out'),
  };
  const isOpen = () => lb.style.display !== 'none';
  const geom = () => ({
    cx: img.offsetLeft + img.offsetWidth / 2,
    cy: img.offsetTop + img.offsetHeight / 2,
    w: img.offsetWidth,
    h: img.offsetHeight,
    vw: lb.clientWidth,
    vh: lb.clientHeight,
  });
  const zoomAt = (scale, px, py, animate) => {
    if (!img.offsetWidth) return; // nothing loaded yet
    iz.st = this._izZoomAround(iz.st, scale, px, py, geom());
    this._izApply(animate);
  };
  const zoomByStep = (f) => zoomAt(iz.st.scale * f, lb.clientWidth / 2, lb.clientHeight / 2, true);

  img.draggable = false;
  img.addEventListener('dragstart', (e) => e.preventDefault());

  lb.addEventListener('wheel', (e) => {
    if (!isOpen()) return;
    e.preventDefault();
    const f = this._izWheelFactor(e.deltaY, e.deltaMode, e.ctrlKey, lb.clientHeight);
    // A mouse wheel moves in notches; ease those. A trackpad sends a stream
    // of small steps that would only lag behind an animation.
    zoomAt(iz.st.scale * f, e.clientX, e.clientY, Math.abs(e.deltaY) >= 40 || e.deltaMode !== 0);
  }, { passive: false });

  lb.addEventListener('pointerdown', (e) => {
    if (!isOpen() || e.target.closest('button')) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    iz.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (iz.pointers.size === 1) {
      iz.gesture = {
        x0: e.clientX, y0: e.clientY, tx0: iz.st.tx, ty0: iz.st.ty,
        moved: false, panning: false, onImage: e.target === img,
        canSwipe: e.pointerType !== 'mouse' && iz.st.scale === 1 && (this._getLightboxImages?.().length || 0) > 1,
      };
    } else if (iz.pointers.size === 2) {
      const [p, q] = [...iz.pointers.values()];
      iz.gesture = {
        pinch: true, moved: true,
        d0: Math.hypot(q.x - p.x, q.y - p.y) || 1,
        mx0: (p.x + q.x) / 2, my0: (p.y + q.y) / 2,
        st0: { ...iz.st },
      };
      lb.classList.add('is-panning');
    }
    // Stops the browser starting a text selection under a mouse drag.
    if (e.pointerType === 'mouse' && iz.st.scale > 1) e.preventDefault();
  });

  lb.addEventListener('pointermove', (e) => {
    const p = iz.pointers.get(e.pointerId);
    const g = iz.gesture;
    if (!p || !g) return;
    p.x = e.clientX; p.y = e.clientY;
    if (g.pinch) {
      if (iz.pointers.size < 2 || !img.offsetWidth) return;
      const [a, b] = [...iz.pointers.values()];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const box = geom();
      const z = this._izZoomAround(g.st0, g.st0.scale * d / g.d0, g.mx0, g.my0, box);
      iz.st = this._izClamp({
        scale: z.scale,
        tx: z.tx + (a.x + b.x) / 2 - g.mx0,
        ty: z.ty + (a.y + b.y) / 2 - g.my0,
      }, box);
      this._izApply(false);
      return;
    }
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (!g.moved && Math.hypot(dx, dy) > DRAG_SLOP) {
      g.moved = true;
      if (iz.st.scale > 1) {
        g.panning = true;
        lb.classList.add('is-panning');
        // Touch pointers are captured by the browser already.
        if (e.pointerType === 'mouse') lb.setPointerCapture(e.pointerId);
      }
    }
    if (g.panning) {
      iz.st = this._izClamp({ scale: iz.st.scale, tx: g.tx0 + dx, ty: g.ty0 + dy }, geom());
      this._izApply(false);
    } else if (g.moved && g.canSwipe) {
      g.swiping = true;
      img.classList.remove('lightbox-img-animate');
      img.style.transform = `translateX(${dx}px)`;
    }
  });

  const endPointer = (e, cancelled) => {
    if (!iz.pointers.has(e.pointerId)) return;
    iz.pointers.delete(e.pointerId);
    const g = iz.gesture;
    if (iz.pointers.size === 1 && g && g.pinch) {
      // One finger lifted off a pinch: the other carries on as a pan.
      const [rest] = [...iz.pointers.values()];
      iz.gesture = { x0: rest.x, y0: rest.y, tx0: iz.st.tx, ty0: iz.st.ty, moved: true, panning: iz.st.scale > 1, onImage: false };
      return;
    }
    if (iz.pointers.size > 0) return;
    lb.classList.remove('is-panning');
    iz.gesture = null;
    if (!g) return;
    if (g.moved) {
      // The click that follows a drag or pinch is not a backdrop click.
      iz.eatClickUntil = performance.now() + 400;
      iz.lastTap = null;
      if (g.swiping) {
        const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
        const dir = !cancelled && this._izSwipeDir(dx, dy);
        if (dir) this._lightboxNavigate(dir);
        else this._izApply(true);
      }
      return;
    }
    if (cancelled || !g.onImage) { iz.lastTap = null; return; }
    const now = performance.now();
    const last = iz.lastTap;
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - last.x, e.clientY - last.y) < DOUBLE_TAP_PX) {
      iz.lastTap = null;
      if (iz.st.scale > 1) { iz.st = { scale: 1, tx: 0, ty: 0 }; this._izApply(true); }
      else zoomAt(TOGGLE_SCALE, e.clientX, e.clientY, true);
    } else {
      iz.lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
  };
  lb.addEventListener('pointerup', (e) => endPointer(e, false));
  lb.addEventListener('pointercancel', (e) => endPointer(e, true));

  // Capture phase, so it runs before the lightbox's own backdrop-click close.
  lb.addEventListener('click', (e) => {
    if (performance.now() < iz.eatClickUntil) {
      iz.eatClickUntil = 0;
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  }, true);

  // The phone layout opens its side panels on an edge swipe that ends
  // anywhere on the page; a pan or pinch here must not count as one.
  lb.addEventListener('touchend', (e) => e.stopPropagation());

  // Capture phase on the document, ahead of type-to-focus, which would
  // otherwise move these keys into the message box behind the lightbox.
  document.addEventListener('keydown', (e) => {
    if (!isOpen() || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === '+' || e.key === '=') zoomByStep(STEP);
    else if (e.key === '-' || e.key === '_') zoomByStep(1 / STEP);
    else if (e.key === '0') { iz.st = { scale: 1, tx: 0, ty: 0 }; this._izApply(true); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  }, true);

  iz.inBtn?.addEventListener('click', (e) => { e.stopPropagation(); zoomByStep(STEP); });
  iz.outBtn?.addEventListener('click', (e) => { e.stopPropagation(); zoomByStep(1 / STEP); });
  iz.level?.addEventListener('click', (e) => {
    e.stopPropagation();
    iz.st = { scale: 1, tx: 0, ty: 0 };
    this._izApply(true);
  });

  window.addEventListener('resize', () => {
    if (!isOpen() || iz.st.scale === 1) return;
    iz.st = this._izClamp(iz.st, geom());
    this._izApply(false);
  });

  this._izApply(false);
},

_izApply(animate) {
  const iz = this._iz;
  if (!iz) return;
  const { img, lb, st } = iz;
  img.classList.toggle('lightbox-img-animate', !!animate);
  img.style.transform = st.scale === 1 ? '' : `translate(${st.tx}px, ${st.ty}px) scale(${st.scale})`;
  lb.classList.toggle('is-zoomed', st.scale > 1);
  if (iz.level) iz.level.textContent = `${Math.round(st.scale * 100)}%`;
  if (iz.inBtn) iz.inBtn.disabled = st.scale >= MAX_SCALE;
  if (iz.outBtn) iz.outBtn.disabled = st.scale <= MIN_SCALE;
},

// Back to fit: a new picture, or the lightbox closing.
_imageZoomReset() {
  const iz = this._iz;
  if (!iz) return;
  iz.st = { scale: 1, tx: 0, ty: 0 };
  iz.pointers.clear();
  iz.gesture = null;
  iz.lastTap = null;
  iz.lb.classList.remove('is-panning');
  this._izApply(false);
},

};
