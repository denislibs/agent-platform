/**
 * «Поле точек» — анимированный фон экрана входа (перенос design/dot-field.js).
 * Сетка точек, сквозь которую видны медленно плывущие цветовые поля, и мягкая подсветка
 * у курсора. Цвета — из токенов --bg-void, --field-dot, --field-glow, --field-1…5; при смене
 * темы (data-theme на <html> или системной темы) фон перечитывает их сам.
 */
import { prefersReducedMotion } from '../lib/media.ts';

const STEP = 14; // шаг сетки, px
const DOT = 1; // радиус точки, px
const GLOW_RADIUS = 180; // радиус подсветки у курсора, px
const STILL_FRAME = 12000; // момент времени для единственного кадра при reduced motion, мс

interface ColorField {
  color: string;
  ax: number;
  ay: number;
  fx: number;
  fy: number;
  px: number;
  py: number;
  r: number;
  fr: number;
}

export interface DotFieldOptions {
  /** Где слушать указатель; по умолчанию — родитель canvas. */
  pointerTarget?: HTMLElement | null;
  /** По умолчанию — prefers-reduced-motion. */
  reducedMotion?: boolean;
}

export interface DotFieldHandle {
  /** Перечитать цвета из токенов (смену data-theme фон замечает сам). */
  refresh(): void;
  /** Остановить анимацию и снять все обработчики. */
  destroy(): void;
}

/** Запускает фон на canvas. `null` — у браузера нет 2D-контекста (фон просто не рисуется). */
export function mountDotField(canvas: HTMLCanvasElement, options: DotFieldOptions = {}): DotFieldHandle | null {
  const ctx = canvas.getContext('2d');
  const layer = document.createElement('canvas');
  const lctx = layer.getContext('2d');
  if (!ctx || !lctx) return null;
  const reduced = options.reducedMotion ?? prefersReducedMotion();
  const pointerTarget = options.pointerTarget ?? canvas.parentElement ?? canvas;

  let dpr = 1;
  let maskPattern: CanvasPattern | string = 'transparent';
  let dimPattern: CanvasPattern | string = 'transparent';
  let voidColor = '#000000';
  let glow = '255,255,255';
  let fields: ColorField[] = [];
  const pointer = { x: 0, y: 0, tx: 0, ty: 0, a: 0, ta: 0, seen: false };

  function dotTile(color: string): HTMLCanvasElement {
    const tile = document.createElement('canvas');
    tile.width = tile.height = Math.round(STEP * dpr);
    const t = tile.getContext('2d');
    if (t) {
      t.fillStyle = color;
      t.beginPath();
      t.arc(tile.width / 2, tile.height / 2, DOT * dpr, 0, Math.PI * 2);
      t.fill();
    }
    return tile;
  }

  function readTheme() {
    const css = getComputedStyle(document.documentElement);
    voidColor = css.getPropertyValue('--bg-void').trim() || voidColor;
    const dotColor = css.getPropertyValue('--field-dot').trim();
    glow = css.getPropertyValue('--field-glow').trim().split(/\s+/).join(',') || glow;
    // Каждое поле дрейфует по своей фигуре Лиссажу (периоды 40–70 с) и медленно «дышит».
    fields = [1, 2, 3, 4, 5].map((n, i) => ({
      color: css.getPropertyValue(`--field-${n}`).trim(),
      ax: 0.32 + 0.05 * i,
      ay: 0.26 + 0.04 * ((i * 3) % 5),
      fx: (2 * Math.PI) / (40 + i * 7),
      fy: (2 * Math.PI) / (52 + i * 5),
      px: i * 1.7,
      py: i * 2.3,
      r: 0.36 + 0.05 * (i % 3),
      fr: (2 * Math.PI) / (18 + i * 4),
    }));
    maskPattern = lctx!.createPattern(dotTile('#fff'), 'repeat') ?? 'transparent';
    dimPattern = ctx!.createPattern(dotTile(dotColor), 'repeat') ?? 'transparent';
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(devicePixelRatio || 1, 2);
    for (const c of [canvas, layer]) {
      c.width = Math.round(rect.width * dpr);
      c.height = Math.round(rect.height * dpr);
    }
    readTheme();
  }

  function frame(ms: number) {
    const t = ms / 1000;
    const W = canvas.width;
    const H = canvas.height;
    const m = Math.min(W, H);
    const l = lctx!;
    const c = ctx!;

    // 1. Цветовые поля
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, W, H);
    l.globalCompositeOperation = 'lighter';
    for (const f of fields) {
      const x = W * (0.5 + f.ax * Math.sin(t * f.fx + f.px));
      const y = H * (0.5 + f.ay * Math.cos(t * f.fy + f.py));
      const r = m * f.r * (1 + 0.12 * Math.sin(t * f.fr));
      const g = l.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, `${f.color}cc`);
      g.addColorStop(0.5, `${f.color}55`);
      g.addColorStop(1, `${f.color}00`);
      l.fillStyle = g;
      l.fillRect(0, 0, W, H);
    }

    // 2. Подсветка у курсора с инерцией
    pointer.x += (pointer.tx - pointer.x) * 0.08;
    pointer.y += (pointer.ty - pointer.y) * 0.08;
    pointer.a += (pointer.ta - pointer.a) * 0.06;
    if (pointer.a > 0.01) {
      const px = pointer.x * dpr;
      const py = pointer.y * dpr;
      const g = l.createRadialGradient(px, py, 0, px, py, GLOW_RADIUS * dpr);
      g.addColorStop(0, `rgba(${glow},${0.75 * pointer.a})`);
      g.addColorStop(1, `rgba(${glow},0)`);
      l.fillStyle = g;
      l.fillRect(0, 0, W, H);
    }

    // 3. Цвет остаётся только там, где точки
    l.globalCompositeOperation = 'destination-in';
    l.fillStyle = maskPattern;
    l.fillRect(0, 0, W, H);

    // 4. Сборка: фон → тусклые точки → цветные точки → виньетка
    c.globalCompositeOperation = 'source-over';
    c.fillStyle = voidColor;
    c.fillRect(0, 0, W, H);
    c.fillStyle = dimPattern;
    c.fillRect(0, 0, W, H);
    c.globalAlpha = 0.9;
    c.drawImage(layer, 0, 0);
    c.globalAlpha = 1;
    const v = c.createRadialGradient(W / 2, H / 2, m * 0.18, W / 2, H / 2, Math.hypot(W, H) / 2);
    v.addColorStop(0, `${voidColor}b3`);
    v.addColorStop(0.35, `${voidColor}00`);
    v.addColorStop(1, `${voidColor}e6`);
    c.fillStyle = v;
    c.fillRect(0, 0, W, H);
  }

  let raf: number | null = null;
  let visible = true;
  const loop = (ms: number) => {
    frame(ms);
    raf = requestAnimationFrame(loop);
  };
  const start = () => {
    if (raf === null && visible && !document.hidden && !reduced) raf = requestAnimationFrame(loop);
  };
  const stop = () => {
    if (raf !== null) cancelAnimationFrame(raf);
    raf = null;
  };

  const onMove = (event: PointerEvent) => {
    const rect = canvas.getBoundingClientRect();
    pointer.tx = event.clientX - rect.left;
    pointer.ty = event.clientY - rect.top;
    pointer.ta = 1;
    if (!pointer.seen) {
      pointer.x = pointer.tx;
      pointer.y = pointer.ty;
      pointer.seen = true;
    }
  };
  const onLeave = () => {
    pointer.ta = 0;
  };
  const onResize = () => {
    resize();
    if (reduced) frame(STILL_FRAME);
  };
  const onVisibility = () => (document.hidden ? stop() : start());
  const onTheme = () => {
    readTheme();
    if (reduced) frame(STILL_FRAME);
  };
  const themeObserver = new MutationObserver(onTheme);
  const systemTheme = matchMedia('(prefers-color-scheme: light)');
  const io = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    if (visible) start();
    else stop();
  });

  resize();
  addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  systemTheme.addEventListener('change', onTheme);
  io.observe(canvas);
  if (reduced) frame(STILL_FRAME);
  else {
    pointerTarget.addEventListener('pointermove', onMove);
    pointerTarget.addEventListener('pointerleave', onLeave);
    start();
  }

  return {
    refresh: onTheme,
    destroy() {
      stop();
      io.disconnect();
      themeObserver.disconnect();
      systemTheme.removeEventListener('change', onTheme);
      removeEventListener('resize', onResize);
      document.removeEventListener('visibilitychange', onVisibility);
      pointerTarget.removeEventListener('pointermove', onMove);
      pointerTarget.removeEventListener('pointerleave', onLeave);
    },
  };
}
