export const FADE_CLASS = 'text-changed'
export const FADE_GAP_MS = 1000

export interface Row<T> {
  el: HTMLElement
  update: (item: T) => HTMLElement[]
}

export interface Item<T> {
  key: string
  sig: string
  value: T
}

interface Entry<T> {
  row: Row<T>
  sig: string
  fadedAt: number
}

export function setText(el: Element, text: string): boolean {
  if (el.textContent === text) return false
  el.textContent = text
  return true
}

export function setAttr(el: Element, name: string, value: string | null): boolean {
  if (el.getAttribute(name) === value) return false
  if (value === null) el.removeAttribute(name)
  else el.setAttribute(name, value)
  return true
}

const wired = new WeakSet<Element>()

function restartFade(el: HTMLElement): void {
  if (!wired.has(el)) {
    wired.add(el)
    el.addEventListener('animationend', (event) => {
      if (event.target === el) el.classList.remove(FADE_CLASS)
    })
  }
  if (el.classList.contains(FADE_CLASS)) {
    el.classList.remove(FADE_CLASS)
    void el.offsetWidth
  }
  el.classList.add(FADE_CLASS)
}

export function createPatcher<T>(
  container: Element,
  build: (item: T) => Row<T>,
  now: () => number = Date.now,
): (items: readonly Item<T>[]) => void {
  const entries = new Map<string, Entry<T>>()
  return (items) => {
    const wanted = new Set(items.map((item) => item.key))
    for (const [key, entry] of entries) {
      if (wanted.has(key)) continue
      entry.row.el.remove()
      entries.delete(key)
    }
    let cursor = container.firstElementChild
    for (const { key, sig, value } of items) {
      let entry = entries.get(key)
      if (!entry) {
        entry = { row: build(value), sig, fadedAt: Number.NEGATIVE_INFINITY }
        entries.set(key, entry)
      } else if (entry.sig !== sig) {
        entry.sig = sig
        const changed = entry.row.update(value)
        const at = now()
        if (changed.length > 0 && at - entry.fadedAt >= FADE_GAP_MS) {
          entry.fadedAt = at
          for (const el of changed) restartFade(el)
        }
      }
      const el = entry.row.el
      if (el === cursor) cursor = cursor.nextElementSibling
      else container.insertBefore(el, cursor)
    }
  }
}
