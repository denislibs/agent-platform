/**
 * «Поле точек» — анимированный фон экрана входа.
 * Сетка точек, сквозь которую видны медленно плывущие цветовые поля,
 * плюс мягкая подсветка вокруг курсора. Цвета берутся из токенов
 * --bg-void, --field-dot, --field-1…5, поэтому фон следует теме.
 *
 *   import { mountDotField } from './dot-field.js';
 *   const field = mountDotField(canvas);   // field.refresh() после смены темы, field.destroy()
 */

const STEP = 14;          // шаг сетки, px
const DOT = 1;            // радиус точки, px
const GLOW_RADIUS = 180;  // радиус подсветки у курсора, px
const STILL_FRAME = 12000; // кадр для prefers-reduced-motion, мс

export function mountDotField(canvas, { pointerTarget = canvas.parentElement } = {}) {
  const ctx = canvas.getContext('2d');
  const layer = document.createElement('canvas');
  const lctx = layer.getContext('2d');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let w = 0, h = 0, dpr = 1;
  let maskPattern, dimPattern, voidColor, glow, fields = [];
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, a: 0, ta: 0, seen: false };

  function readTheme() {
    const css = getComputedStyle(document.documentElement);
    voidColor = css.getPropertyValue('--bg-void').trim();
    const dotColor = css.getPropertyValue('--field-dot').trim();
    glow = css.getPropertyValue('--field-glow').trim().split(/\s+/).join(',');
    // Каждое поле дрейфует по своей фигуре Лиссажу (периоды 40–70 с) и медленно «дышит».
    fields = [1, 2, 3, 4, 5].map((n, i) => ({
      c: css.getPropertyValue('--field-' + n).trim(),
      ax: 0.32 + 0.05 * i, ay: 0.26 + 0.04 * ((i * 3) % 5),
      fx: (2 * Math.PI) / (40 + i * 7), fy: (2 * Math.PI) / (52 + i * 5),
      px: i * 1.7, py: i * 2.3, r: 0.36 + 0.05 * (i % 3), fr: (2 * Math.PI) / (18 + i * 4),
    }));
    maskPattern = lctx.createPattern(dotTile('#fff'), 'repeat');
    dimPattern = ctx.createPattern(dotTile(dotColor), 'repeat');
  }

  function dotTile(color) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = Math.round(STEP * dpr);
    const t = tile.getContext('2d');
    t.fillStyle = color;
    t.beginPath();
    t.arc(tile.width / 2, tile.height / 2, DOT * dpr, 0, Math.PI * 2);
    t.fill();
    return tile;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = rect.width; h = rect.height;
    for (const c of [canvas, layer]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    readTheme();
  }

  function frame(ms) {
    const t = ms / 1000;
    const W = canvas.width, H = canvas.height, m = Math.min(W, H);

    // 1. Цветовые поля
    lctx.globalCompositeOperation = 'source-over';
    lctx.clearRect(0, 0, W, H);
    lctx.globalCompositeOperation = 'lighter';
    for (const f of fields) {
      const x = W * (0.5 + f.ax * Math.sin(t * f.fx + f.px));
      const y = H * (0.5 + f.ay * Math.cos(t * f.fy + f.py));
      const r = m * f.r * (1 + 0.12 * Math.sin(t * f.fr));
      const g = lctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, f.c + 'cc'); g.addColorStop(0.5, f.c + '55'); g.addColorStop(1, f.c + '00');
      lctx.fillStyle = g;
      lctx.fillRect(0, 0, W, H);
    }

    // 2. Подсветка у курсора с инерцией
    pointer.x += (pointer.tx - pointer.x) * 0.08;
    pointer.y += (pointer.ty - pointer.y) * 0.08;
    pointer.a += (pointer.ta - pointer.a) * 0.06;
    if (pointer.a > 0.01) {
      const px = pointer.x * dpr, py = pointer.y * dpr, pr = GLOW_RADIUS * dpr;
      const g = lctx.createRadialGradient(px, py, 0, px, py, pr);
      g.addColorStop(0, `rgba(${glow},${0.75 * pointer.a})`);
      g.addColorStop(1, `rgba(${glow},0)`);
      lctx.fillStyle = g;
      lctx.fillRect(0, 0, W, H);
    }

    // 3. Цвет остаётся только там, где точки
    lctx.globalCompositeOperation = 'destination-in';
    lctx.fillStyle = maskPattern;
    lctx.fillRect(0, 0, W, H);

    // 4. Сборка: фон → тусклые точки → цветные точки → виньетка
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = voidColor; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = dimPattern; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 0.9; ctx.drawImage(layer, 0, 0); ctx.globalAlpha = 1;
    const v = ctx.createRadialGradient(W / 2, H / 2, m * 0.18, W / 2, H / 2, Math.hypot(W, H) / 2);
    v.addColorStop(0, voidColor + 'b3'); v.addColorStop(0.35, voidColor + '00'); v.addColorStop(1, voidColor + 'e6');
    ctx.fillStyle = v; ctx.fillRect(0, 0, W, H);
  }

  let raf = null, visible = true;
  const loop = ms => { frame(ms); raf = requestAnimationFrame(loop); };
  const start = () => { if (!raf && visible && !document.hidden && !reduced) raf = requestAnimationFrame(loop); };
  const stop = () => { cancelAnimationFrame(raf); raf = null; };

  const onMove = e => {
    const r = canvas.getBoundingClientRect();
    pointer.tx = e.clientX - r.left; pointer.ty = e.clientY - r.top; pointer.ta = 1;
    if (!pointer.seen) { pointer.x = pointer.tx; pointer.y = pointer.ty; pointer.seen = true; }
  };
  const onLeave = () => { pointer.ta = 0; };
  const onResize = () => { resize(); if (reduced) frame(STILL_FRAME); };
  const onVisibility = () => (document.hidden ? stop() : start());
  const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; visible ? start() : stop(); });

  resize();
  addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  io.observe(canvas);
  if (reduced) frame(STILL_FRAME);
  else {
    pointerTarget.addEventListener('pointermove', onMove);
    pointerTarget.addEventListener('pointerleave', onLeave);
    start();
  }

  return {
    /** Перечитать цвета из токенов, например после смены темы. */
    refresh() { readTheme(); if (reduced) frame(STILL_FRAME); },
    destroy() {
      stop(); io.disconnect();
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      pointerTarget.removeEventListener('pointermove', onMove);
      pointerTarget.removeEventListener('pointerleave', onLeave);
    },
  };
}
