/// <reference lib="dom" />

const TEST_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-cy', 'data-qa']

export const tagOf = (el: Element): string => el.tagName.toLowerCase()

export function createSelectors(win: Window & typeof globalThis) {
  const doc = win.document
  const escapeIdent = (s: string): string =>
    win.CSS?.escape ? win.CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`)
  const quote = (s: string): string => `"${s.replace(/["\\]/g, (c) => `\\${c}`)}"`

  const matchesOnly = (sel: string, el: Element): boolean => {
    try {
      const found = doc.querySelectorAll(sel)
      return found.length === 1 && found[0] === el
    } catch {
      return false
    }
  }

  const anchorFor = (el: Element): string | null => {
    const tag = tagOf(el)
    if (el.id) {
      const byId = `#${escapeIdent(el.id)}`
      if (matchesOnly(byId, el)) return byId
    }
    for (const attr of TEST_ATTRS) {
      const value = el.getAttribute(attr)
      if (!value) continue
      const byAttr = `[${attr}=${quote(value)}]`
      if (matchesOnly(byAttr, el)) return byAttr
      if (matchesOnly(`${tag}${byAttr}`, el)) return `${tag}${byAttr}`
    }
    const aria = el.getAttribute('aria-label')
    if (aria) {
      const byAria = `${tag}[aria-label=${quote(aria)}]`
      if (matchesOnly(byAria, el)) return byAria
    }
    const name = el.getAttribute('name')
    if (name && /^(input|select|textarea|button|form)$/.test(tag)) {
      const byName = `${tag}[name=${quote(name)}]`
      if (matchesOnly(byName, el)) return byName
    }
    return null
  }

  const stepFor = (el: Element): string => {
    const tag = tagOf(el)
    const parent = el.parentElement
    if (!parent) return tag
    const same = Array.from(parent.children).filter((c) => c.tagName === el.tagName)
    return same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(el) + 1})` : tag
  }

  const selectorFor = (el: Element): string => {
    const direct = anchorFor(el)
    if (direct) return direct
    const steps: string[] = []
    let cur: Element | null = el
    while (cur && cur !== doc.documentElement) {
      const anchor: string | null = cur === el ? null : anchorFor(cur)
      if (anchor) {
        steps.unshift(anchor)
        const anchored = steps.join(' > ')
        if (matchesOnly(anchored, el)) return anchored
        break
      }
      steps.unshift(stepFor(cur))
      const joined = steps.join(' > ')
      if (steps.length > 1 && matchesOnly(joined, el)) return joined
      cur = cur.parentElement
    }
    const full: string[] = []
    let node: Element | null = el
    while (node && node !== doc.documentElement) {
      full.unshift(stepFor(node))
      node = node.parentElement
    }
    return ['html', ...full].join(' > ')
  }

  return { selectorFor }
}
