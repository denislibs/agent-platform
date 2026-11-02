import type { Ref } from 'preact';
import { useMemo } from 'preact/hooks';

/** Один ref-колбэк для нескольких ref: внешний (forwardRef) и внутренний. */
export function mergeRefs<T>(...refs: Array<Ref<T> | null | undefined>): (node: T | null) => void {
  return node => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    }
  };
}

/** То же для компонентов: колбэк стабилен, пока не сменились сами ref (иначе Preact перевызывает его каждый рендер). */
export function useMergedRefs<T>(a: Ref<T> | null | undefined, b: Ref<T> | null | undefined): (node: T | null) => void {
  return useMemo(() => mergeRefs(a, b), [a, b]);
}
