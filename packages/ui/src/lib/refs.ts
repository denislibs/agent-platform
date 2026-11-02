import type { Ref } from 'preact';

/** Один ref-колбэк для нескольких ref: внешний (forwardRef) и внутренний. */
export function mergeRefs<T>(...refs: Array<Ref<T> | null | undefined>): (node: T | null) => void {
  return node => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    }
  };
}
