export function focusSibling(
  rows: readonly HTMLElement[],
  from: Element | null,
  step: 1 | -1,
): boolean {
  const next = rows[rows.findIndex((row) => row === from) + step]
  if (!next) return false
  next.focus()
  return true
}
