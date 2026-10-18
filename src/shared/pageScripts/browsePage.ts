/// <reference lib="dom" />
import type { BrowseRuntime } from '../browser/browseRuntime'
import { checkedOf, roleOf } from './ariaRoles'
import { createSnapshot } from './ariaSnapshot'
import { createActions } from './pageActions'
import { createLayout } from './pageLayout'
import { createFinders, createReads } from './pageQueries'
import { createStorage } from './pageStorage'
import { createTargets } from './pageTargets'

export function browseRuntime(win: Window & typeof globalThis): BrowseRuntime {
  const topDoc = win.document
  const { ref, frameDoc, lookup, resolve, frame } = createTargets(topDoc)
  const { hasBox, isRendered, isVisible, frameOffset } = createLayout(win)
  const snapshot = createSnapshot({ frameDoc, lookup, ref, isRendered, hasBox })
  const { point, withElement, fill, select, scrollIntoView, scroll, highlight, mark, href } =
    createActions({ win, resolve, frameDoc, frameOffset })
  const { get, is } = createReads({
    win,
    topDoc,
    resolve,
    frameDoc,
    isVisible,
    frameOffset,
    withElement,
  })
  const { find, hasState, hasText, unmark } = createFinders({
    topDoc,
    resolve,
    frameDoc,
    ref,
    isVisible,
  })
  const { dumpArea, areaOf, storageOp } = createStorage(win)

  return {
    resolve,
    ref,
    snapshot,
    point,
    focus: (target) =>
      withElement(target, (el) => {
        ;(el as HTMLElement).focus?.()
        const field = el as HTMLInputElement
        if (typeof field.value === 'string' && typeof field.setSelectionRange === 'function') {
          try {
            field.setSelectionRange(field.value.length, field.value.length)
          } catch {}
        }
        return { ok: true }
      }),
    fill,
    select,
    checked: (target) =>
      withElement(target, (el) => ({
        ok: true,
        value: checkedOf(el, roleOf(el) || 'checkbox') === true,
      })),
    scrollIntoView,
    scroll,
    highlight,
    get,
    is,
    find,
    hasState,
    hasText,
    frame,
    mark,
    unmark,
    href,
    readyState: () => topDoc.readyState,
    readText: () => (topDoc.body ? (topDoc.body.innerText ?? topDoc.body.textContent ?? '') : ''),
    storage: () => {
      let local: Record<string, string> = {}
      let session: Record<string, string> = {}
      try {
        local = dumpArea(win.localStorage)
      } catch {}
      try {
        session = dumpArea(win.sessionStorage)
      } catch {}
      return { origin: win.location.origin, local, session }
    },
    setStorage: (area, key, value) => storageOp(() => areaOf(area).setItem(key, value)),
    removeStorage: (area, key) => storageOp(() => areaOf(area).removeItem(key)),
    clearStorage: (area) => storageOp(() => areaOf(area).clear()),
  }
}
