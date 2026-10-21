/// <reference lib="dom" />
import type { BrowseOutcome } from '../browser/browseRuntime'
import { collapse, describeElement, fail, SKIP_TAGS } from './pageText'

export function createTargets(topDoc: Document) {
  const refs = new Map<string, Element>()
  const ids = new WeakMap<Element, string>()
  let counter = 0
  let frameTarget: string | null = null

  const ref = (el: Element): string => {
    const known = ids.get(el)
    if (known && refs.get(known) === el) return known
    counter += 1
    const id = `e${counter}`
    ids.set(el, id)
    refs.set(id, el)
    return id
  }

  const frameDoc = (): Document => {
    if (!frameTarget) return topDoc
    const frameEl = lookup(topDoc, frameTarget)
    try {
      const doc = (frameEl as HTMLIFrameElement | null)?.contentDocument
      return doc ?? topDoc
    } catch {
      return topDoc
    }
  }

  const byText = (doc: Document, text: string): Element | null => {
    const wanted = text.toLowerCase()
    let best: Element | null = null
    let bestSize = Number.POSITIVE_INFINITY
    for (const el of Array.from(doc.body?.querySelectorAll('*') ?? [])) {
      if (SKIP_TAGS.has(el.tagName.toLowerCase())) continue
      const own = collapse((el as HTMLElement).innerText ?? el.textContent).toLowerCase()
      if (!own.includes(wanted)) continue
      const size = el.querySelectorAll('*').length
      if (size < bestSize) {
        best = el
        bestSize = size
      }
    }
    return best
  }

  function lookup(doc: Document, target: string): Element | null {
    const refMatch = /^@?(e\d+)$/.exec(target)
    if (refMatch) {
      const el = refs.get(refMatch[1])
      return el?.isConnected ? el : null
    }
    if (target.startsWith('text=')) return byText(doc, target.slice(5))
    if (target.startsWith('xpath=')) {
      try {
        const result = doc.evaluate(target.slice(6), doc, null, 9, null)
        const node = result.singleNodeValue
        return node && node.nodeType === 1 ? (node as Element) : null
      } catch {
        return null
      }
    }
    try {
      return doc.querySelector(target)
    } catch {
      return null
    }
  }

  const resolve = (target: string): Element | null => lookup(frameDoc(), target)

  const frame = (target: string | null): BrowseOutcome => {
    if (!target) {
      frameTarget = null
      return { ok: true }
    }
    const el = lookup(topDoc, target)
    if (!el) return fail('not-found', target)
    if (el.tagName.toLowerCase() !== 'iframe' && el.tagName.toLowerCase() !== 'frame') {
      return fail('not-a-frame', describeElement(el))
    }
    try {
      if (!(el as HTMLIFrameElement).contentDocument) return fail('cross-origin-frame', target)
    } catch {
      return fail('cross-origin-frame', target)
    }
    frameTarget = target
    return { ok: true }
  }

  return { ref, frameDoc, lookup, resolve, frame }
}

export type PageTargets = ReturnType<typeof createTargets>
