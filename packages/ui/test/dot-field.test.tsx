import { afterEach, expect, spyOn, test } from 'bun:test';
import { render } from '@testing-library/preact';
import { DotField, mountDotField } from '../src/index.ts';
import { trackGlobalListeners } from './helpers.ts';

// happy-dom не рисует на canvas (getContext → null), поэтому контекст подменяется записывающим двойником.
function fakeContext() {
  const calls = { drawImage: 0, fillRect: 0 };
  const context = {
    calls,
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
    fillStyle: '',
    createPattern: () => ({}),
    createRadialGradient: () => ({ addColorStop() {} }),
    clearRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    fillRect() {
      calls.fillRect++;
    },
    drawImage() {
      calls.drawImage++;
    },
  };
  return context;
}

const restore: Array<() => void> = [];
afterEach(() => {
  while (restore.length) restore.pop()!();
});

function withCanvas() {
  const contexts: Array<ReturnType<typeof fakeContext>> = [];
  const spy = spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((): unknown => {
    const context = fakeContext();
    contexts.push(context);
    return context;
  }) as never);
  restore.push(() => spy.mockRestore());
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  restore.push(() => host.remove());
  // Первый контекст — у видимого canvas: только он рисует слой полей (drawImage).
  return { canvas, host, frames: () => contexts[0]!.calls.drawImage };
}

function spyFrames() {
  const raf = spyOn(globalThis, 'requestAnimationFrame').mockImplementation(() => 1);
  const cancel = spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  restore.push(
    () => raf.mockRestore(),
    () => cancel.mockRestore(),
  );
  return { raf, cancel };
}

test('without a 2D context mountDotField returns null and DotField renders a decorative canvas', () => {
  expect(mountDotField(document.createElement('canvas'))).toBeNull();
  const { container, unmount } = render(<DotField />);
  const canvas = container.querySelector('canvas')!;
  expect(canvas.getAttribute('aria-hidden')).toBe('true');
  expect(canvas.className).toBe('ui-dot-field');
  unmount();
});

test('with reduced motion the field draws one still frame, never animates and redraws on a theme change', async () => {
  const { canvas, frames } = withCanvas();
  const { raf } = spyFrames();
  const field = mountDotField(canvas, { reducedMotion: true })!;
  expect(frames()).toBe(1);
  expect(raf).not.toHaveBeenCalled();
  document.documentElement.dataset.theme = 'light';
  await Promise.resolve();
  expect(frames()).toBe(2);
  field.destroy();
  document.documentElement.dataset.theme = 'dark';
  await Promise.resolve();
  expect(frames()).toBe(2);
});

test('the animation pauses on a hidden tab, resumes when visible and stops for good on destroy', () => {
  const { canvas } = withCanvas();
  const { raf, cancel } = spyFrames();
  let hidden = false;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  restore.push(() => delete (document as { hidden?: boolean }).hidden);

  const field = mountDotField(canvas, { reducedMotion: false })!;
  expect(raf).toHaveBeenCalledTimes(1);
  hidden = true;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(cancel).toHaveBeenCalledTimes(1);
  hidden = false;
  document.dispatchEvent(new Event('visibilitychange'));
  expect(raf).toHaveBeenCalledTimes(2);
  field.destroy();
  expect(cancel).toHaveBeenCalledTimes(2);
  document.dispatchEvent(new Event('visibilitychange'));
  expect(raf).toHaveBeenCalledTimes(2);
});

test('destroy releases every global and pointer listener, observer and pending frame', () => {
  const { canvas, host } = withCanvas();
  const { cancel } = spyFrames();
  const tracker = trackGlobalListeners();
  restore.push(() => tracker.restore());

  const disconnected: string[] = [];
  const observe = (name: string, prototype: { disconnect(): void }) => {
    const spy = spyOn(prototype, 'disconnect').mockImplementation(() => {
      disconnected.push(name);
    });
    restore.push(() => spy.mockRestore());
  };
  observe('mutation', MutationObserver.prototype);
  observe('intersection', IntersectionObserver.prototype);

  const pointerTypes: string[] = [];
  const addHost = host.addEventListener.bind(host);
  const removeHost = host.removeEventListener.bind(host);
  host.addEventListener = ((type: string, listener: never, options: never) => {
    pointerTypes.push(type);
    addHost(type, listener, options);
  }) as never;
  host.removeEventListener = ((type: string, listener: never, options: never) => {
    pointerTypes.splice(pointerTypes.indexOf(type), 1);
    removeHost(type, listener, options);
  }) as never;

  const systemTheme = window.matchMedia('(prefers-color-scheme: light)');
  const mediaListeners = new Set<unknown>();
  const mediaProto = Object.getPrototypeOf(systemTheme) as MediaQueryList;
  const addMedia = spyOn(mediaProto, 'addEventListener').mockImplementation(((type: string, listener: unknown) => {
    if (type === 'change') mediaListeners.add(listener);
  }) as never);
  const removeMedia = spyOn(mediaProto, 'removeEventListener').mockImplementation(((
    type: string,
    listener: unknown,
  ) => {
    if (type === 'change') mediaListeners.delete(listener);
  }) as never);
  restore.push(
    () => addMedia.mockRestore(),
    () => removeMedia.mockRestore(),
  );

  const field = mountDotField(canvas, { reducedMotion: false })!;
  expect(tracker.types()).toEqual(['resize', 'visibilitychange']);
  expect(pointerTypes.toSorted()).toEqual(['pointerleave', 'pointermove']);
  expect(mediaListeners.size).toBe(1);

  field.destroy();
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(tracker.types()).toEqual([]);
  expect(pointerTypes).toEqual([]);
  expect(mediaListeners.size).toBe(0);
  expect(disconnected.toSorted()).toEqual(['intersection', 'mutation']);
});

test('the DotField component stops its animation when unmounted', () => {
  const { cancel, raf } = spyFrames();
  const contexts = spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => fakeContext()) as never);
  restore.push(() => contexts.mockRestore());
  const tracker = trackGlobalListeners();
  restore.push(() => tracker.restore());

  const { unmount } = render(<DotField />);
  expect(raf).toHaveBeenCalled();
  expect(tracker.types()).toContain('resize');
  unmount();
  expect(cancel).toHaveBeenCalled();
  expect(tracker.types()).toEqual([]);
});
