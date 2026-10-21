/// <reference lib="dom" />
import type { BrowseOutcome, ElementState, FindQuery } from '../browser/browseRuntime'
import { checkedOf, disabledOf, isClickableGeneric, nameOf, roleOf } from './ariaRoles'
import type { PageActions } from './pageActions'
import type { PageLayout } from './pageLayout'
import type { PageTargets } from './pageTargets'
import { collapse, fail, SKIP_TAGS, textOf } from './pageText'

const STYLE_KEYS = [
  'display',
  'position',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'width',
  'height',
  'margin',
  'padding',
  'opacity',
  'visibility',
]
type ReadDeps = Pick<PageTargets, 'resolve' | 'frameDoc'> &
  Pick<PageLayout, 'isVisible' | 'frameOffset'> &
  Pick<PageActions, 'withElement'> & { win: Window & typeof globalThis; topDoc: Document }

export function createReads({
  win,
  topDoc,
  resolve,
  frameDoc,
  isVisible,
  frameOffset,
  withElement,
}: ReadDeps) {
  const stylesOf = (el: Element, property: string | null): unknown => {
    const view = el.ownerDocument.defaultView ?? win
    const computed = view.getComputedStyle(el)
    if (property) return computed.getPropertyValue(property)
    const out: Record<string, string> = {}
    for (const key of STYLE_KEYS) out[key] = computed.getPropertyValue(key)
    return out
  }

  const get = (
    sub: string,
    target: string | null,
    arg: string | null,
  ): BrowseOutcome<{ value: unknown }> => {
    if (sub === 'title') return { ok: true, value: topDoc.title }
    if (sub === 'url') return { ok: true, value: win.location.href }
    if (!target) return fail('selector-required', sub)
    if (sub === 'count') {
      if (/^@?e\d+$/.test(target)) return { ok: true, value: resolve(target) ? 1 : 0 }
      try {
        return { ok: true, value: frameDoc().querySelectorAll(target).length }
      } catch {
        return fail('bad-selector', target)
      }
    }
    return withElement(target, (el) => {
      switch (sub) {
        case 'text':
          return { ok: true, value: (el as HTMLElement).innerText ?? el.textContent ?? '' }
        case 'html':
          return { ok: true, value: el.innerHTML }
        case 'value':
          return { ok: true, value: (el as HTMLInputElement).value ?? null }
        case 'attr':
          if (!arg) return fail('attr-required')
          return { ok: true, value: el.getAttribute(arg) }
        case 'box': {
          const rect = el.getBoundingClientRect()
          const offset = frameOffset(el)
          return {
            ok: true,
            value: {
              x: rect.x + offset.x,
              y: rect.y + offset.y,
              width: rect.width,
              height: rect.height,
            },
          }
        }
        case 'styles':
          return { ok: true, value: stylesOf(el, arg) }
        default:
          return fail('bad-sub', sub)
      }
    })
  }

  const is = (sub: string, target: string): BrowseOutcome<{ value: boolean }> =>
    withElement(target, (el) => {
      switch (sub) {
        case 'visible':
          return { ok: true, value: isVisible(el) }
        case 'enabled':
          return { ok: true, value: !disabledOf(el) }
        case 'checked':
          return {
            ok: true,
            value: checkedOf(el, roleOf(el) || 'checkbox') === true,
          }
        default:
          return fail('bad-sub', sub)
      }
    })

  return { get, is }
}

type FinderDeps = Pick<PageTargets, 'resolve' | 'frameDoc' | 'ref'> &
  Pick<PageLayout, 'isVisible'> & { topDoc: Document }

export function createFinders({ topDoc, resolve, frameDoc, ref, isVisible }: FinderDeps) {
  const matches = (value: string | null | undefined, query: string, exact: boolean): boolean => {
    if (value === null || value === undefined) return false
    const text = collapse(value)
    return exact ? text === query : text.toLowerCase().includes(query.toLowerCase())
  }

  const candidates = (doc: Document): Element[] =>
    Array.from(doc.querySelectorAll('*')).filter(
      (el) => !SKIP_TAGS.has(el.tagName.toLowerCase()) && isVisible(el),
    )

  const locate = (query: FindQuery): Element | null => {
    const doc = frameDoc()
    const exact = query.exact === true
    switch (query.by) {
      case 'role': {
        const role = query.value.toLowerCase()
        return (
          candidates(doc).find((el) => {
            const elRole = roleOf(el) || (isClickableGeneric(el) ? 'generic' : '')
            if (elRole !== role) return false
            return query.name === undefined || matches(nameOf(el, elRole), query.name, exact)
          }) ?? null
        )
      }
      case 'text': {
        const found = candidates(doc).filter((el) => matches(textOf(el), query.value, exact))
        found.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)
        return found[0] ?? null
      }
      case 'label': {
        for (const label of Array.from(doc.querySelectorAll('label'))) {
          if (!matches(textOf(label), query.value, exact)) continue
          const control = (label as HTMLLabelElement).control
          if (control) return control
        }
        return (
          candidates(doc).find((el) =>
            matches(el.getAttribute('aria-label'), query.value, exact),
          ) ?? null
        )
      }
      case 'placeholder':
      case 'alt':
      case 'title': {
        const attr = query.by
        return (
          candidates(doc).find((el) => matches(el.getAttribute(attr), query.value, exact)) ?? null
        )
      }
      case 'testid':
        return (
          Array.from(doc.querySelectorAll('[data-testid]')).find(
            (el) => el.getAttribute('data-testid') === query.value,
          ) ?? null
        )
      case 'nth': {
        let list: Element[]
        try {
          list = Array.from(doc.querySelectorAll(query.value))
        } catch {
          return null
        }
        const index = query.index ?? 0
        return (index < 0 ? list[list.length + index] : list[index]) ?? null
      }
      default:
        return null
    }
  }

  const find = (query: FindQuery): BrowseOutcome<{ ref: string }> => {
    const el = locate(query)
    return el ? { ok: true, ref: ref(el) } : fail('not-found', `${query.by} ${query.value}`)
  }

  const hasState = (target: string, state: ElementState): boolean => {
    const el = resolve(target)
    switch (state) {
      case 'attached':
        return el !== null
      case 'detached':
        return el === null
      case 'hidden':
        return el === null || !isVisible(el)
      default:
        return el !== null && isVisible(el)
    }
  }

  const hasText = (text: string): boolean => textOf(frameDoc().body ?? topDoc.body).includes(text)

  const unmark = (nonce: string): void => {
    const docs = [topDoc, frameDoc()]
    for (const doc of docs) {
      for (const el of Array.from(doc.querySelectorAll(`[data-ostia-mark="${nonce}"]`))) {
        el.removeAttribute('data-ostia-mark')
      }
    }
  }

  return { find, hasState, hasText, unmark }
}
