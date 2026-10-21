import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import {
  DEFAULT_SCROLL_PX,
  isScrollDirection,
  parseKeyCombo,
  scrollDelta,
} from '../../shared/browser/browseInput'
import type { BrowseInput } from './browseInput'
import {
  type BrowseDeps,
  type BrowseMethod,
  debuggerCommand,
  fail,
  num,
  type OpenTab,
  safeOutPath,
  str,
  world,
} from './browseMethod'
import { jsArgs, runInBrowseWorld } from './browseWorld'

const NEW_TAB_URL = /^(https?|file):/i

interface ActionDeps extends Pick<BrowseDeps, 'screenshotRoots'> {
  method: BrowseMethod
  input: BrowseInput
  openTab: OpenTab
}

export function registerBrowseActionMethods(deps: ActionDeps): void {
  const { method, openTab } = deps
  const { clickTarget, mouseMove, mouseButton, settle, typeText, sendCombo, setChecked } =
    deps.input

  method('click', async (guest, p, ctx) => {
    const target = str(p.target) ?? ''
    if (p.newTab === true) {
      const link = await world<{ url: string }>(guest, `href(${jsArgs(target)})`)
      if (!link.ok) return link
      if (!NEW_TAB_URL.test(link.url)) return fail('unsupported-url', link.url)
      return openTab(ctx, link.url, false)
    }
    return clickTarget(guest, target, 1)
  })

  method('dblclick', (guest, p) => clickTarget(guest, str(p.target) ?? '', 2))

  method('hover', async (guest, p) => {
    const at = await world<{ x: number; y: number }>(guest, `point(${jsArgs(str(p.target))})`)
    if (!at.ok) return at
    mouseMove(guest, at.x, at.y)
    await settle(guest)
    return { ok: true }
  })

  method('focus', (guest, p) => world(guest, `focus(${jsArgs(str(p.target))})`))

  method('fill', (guest, p) => world(guest, `fill(${jsArgs(str(p.target), str(p.text) ?? '')})`))

  method('type', async (guest, p) => {
    const focused = await world(guest, `focus(${jsArgs(str(p.target))})`)
    if (!focused.ok) return focused
    typeText(guest, str(p.text) ?? '')
    await settle(guest)
    return { ok: true }
  })

  method('keyboard', async (guest, p) => {
    const text = str(p.text) ?? ''
    if (p.mode === 'inserttext') guest.insertText(text)
    else if (p.mode === 'type') typeText(guest, text)
    else return fail('bad-sub', String(p.mode))
    await settle(guest)
    return { ok: true }
  })

  const keyMethod = (name: string, phase: 'down' | 'up' | 'press'): void => {
    method(name, async (guest, p) => {
      const combo = parseKeyCombo(str(p.key) ?? '')
      if (!combo) return fail('bad-key', str(p.key))
      sendCombo(guest, combo, phase)
      await settle(guest)
      return { ok: true }
    })
  }
  keyMethod('press', 'press')
  keyMethod('keydown', 'down')
  keyMethod('keyup', 'up')

  method('select', (guest, p) => {
    const values = Array.isArray(p.values) ? p.values.filter((v) => typeof v === 'string') : []
    if (values.length === 0) return fail('value-required')
    return world(guest, `select(${jsArgs(str(p.target), values)})`)
  })

  method('check', (guest, p) => setChecked(guest, str(p.target) ?? '', true))
  method('uncheck', (guest, p) => setChecked(guest, str(p.target) ?? '', false))

  method('scroll', (guest, p) => {
    const direction = p.direction ?? 'down'
    if (!isScrollDirection(direction)) return fail('bad-direction', String(direction))
    const { dx, dy } = scrollDelta(direction, num(p.amount) ?? DEFAULT_SCROLL_PX)
    return world(guest, `scroll(${jsArgs(str(p.target) ?? null, dx, dy)})`)
  })

  method('scrollintoview', (guest, p) => world(guest, `scrollIntoView(${jsArgs(str(p.target))})`))

  method('drag', async (guest, p) => {
    const from = await world<{ x: number; y: number }>(guest, `point(${jsArgs(str(p.source))})`)
    if (!from.ok) return from
    const to = await world<{ x: number; y: number }>(guest, `point(${jsArgs(str(p.target))})`)
    if (!to.ok) return to
    mouseMove(guest, from.x, from.y)
    mouseButton(guest, 'mouseDown', 'left', 1)
    const steps = 10
    for (let i = 1; i <= steps; i++) {
      mouseMove(
        guest,
        from.x + ((to.x - from.x) * i) / steps,
        from.y + ((to.y - from.y) * i) / steps,
      )
      await sleep(10)
    }
    mouseButton(guest, 'mouseUp', 'left', 1)
    await settle(guest)
    return { ok: true }
  })

  method('upload', async (guest, p) => {
    const files = Array.isArray(p.files) ? p.files.filter((f) => typeof f === 'string') : []
    if (files.length === 0) return fail('files-required')
    const safe: string[] = []
    for (const file of files) {
      const path = safeOutPath(deps, file)
      if (!path) return fail('path-denied', file)
      if (!existsSync(path)) return fail('file-not-found', file)
      safe.push(path)
    }
    const nonce = randomUUID()
    const marked = await world(guest, `mark(${jsArgs(str(p.target), nonce)})`)
    if (!marked.ok) return marked
    try {
      await debuggerCommand(guest, 'DOM.getDocument', { depth: 0 })
      const search = await debuggerCommand<{ searchId: string; resultCount: number }>(
        guest,
        'DOM.performSearch',
        { query: `[data-ostia-mark="${nonce}"]` },
      )
      const found = await debuggerCommand<{ nodeIds: number[] }>(guest, 'DOM.getSearchResults', {
        searchId: search.searchId,
        fromIndex: 0,
        toIndex: search.resultCount,
      })
      await debuggerCommand(guest, 'DOM.discardSearchResults', { searchId: search.searchId })
      const nodeId = found.nodeIds[0]
      if (nodeId === undefined) return fail('not-found', str(p.target))
      await debuggerCommand(guest, 'DOM.setFileInputFiles', { files: safe, nodeId })
      return { ok: true, files: safe }
    } finally {
      await runInBrowseWorld(guest, `unmark(${jsArgs(nonce)})`).catch(() => {})
    }
  })
}
