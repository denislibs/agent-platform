import { useEffect, useState } from 'preact/hooks';

/** Соседи строки в списке: чья кнопка получит фокус, когда строки не станет (следующая, иначе предыдущая). */
export function neighbourOf<T extends { id: string }>(list: readonly T[], id: string): string | null {
  const at = list.findIndex(item => item.id === id);
  return (list[at + 1] ?? list[at - 1])?.id ?? null;
}

/**
 * Фокус после удаления строки списка. Кнопка, открывшая диалог, исчезла вместе со строкой, и ловушка фокуса диалога
 * вернуть фокус некуда: он упал бы на <body>. Поэтому, когда диалог закрыт (`idle`), фокус получает кнопка соседней
 * строки, а без соседей — поле поиска этого списка.
 *
 * Элементы находятся по атрибуту `data-removal`: `removalButton(scope, id)` ставится на кнопку удаления строки,
 * `removalField(scope)` — на поле поиска; `scope` отличает список («task», «file»), если на экране их два.
 * `focusAfterRemoval(id)` вызывается после успешного удаления с id соседа (или null, если соседей нет).
 */
export function useRemovalFocus(scope: string, idle: boolean) {
  const [pending, setPending] = useState<{ id: string | null } | null>(null);
  useEffect(() => {
    if (!pending || !idle) return;
    const byKey = (key: string) => document.querySelector<HTMLElement>(`[data-removal="${CSS.escape(key)}"]`);
    // Соседа могло уже не быть (список обновился): тогда поле поиска.
    const target = (pending.id !== null ? byKey(`${scope}:${pending.id}`) : null) ?? byKey(`${scope}-field`);
    target?.focus();
    setPending(null);
  }, [pending, idle, scope]);
  return (id: string | null) => setPending({ id });
}

/** Атрибут кнопки удаления строки. */
export const removalButton = (scope: string, id: string) => ({ 'data-removal': `${scope}:${id}` });
/** Атрибут поля поиска списка: запасная цель фокуса. */
export const removalField = (scope: string) => ({ 'data-removal': `${scope}-field` });
