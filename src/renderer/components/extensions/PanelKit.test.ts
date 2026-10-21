import {
  PANEL_TOOLBAR_EVENT,
  PANEL_TOOLBAR_PATH,
} from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import {
  emptyState,
  h,
  listRow,
  onPanelToolbar,
  quietButton,
  setPanelToolbar,
} from '@aurigax-ai/ostia-extension-sdk/panel'
import { describe, expect, it, vi } from 'vitest'

describe('panel kit', () => {
  describe('quietButton', () => {
    it('draws a quiet button, stronger when asked, that passes its event on', () => {
      const onClick = vi.fn()
      const quiet = quietButton('Find rules', onClick)
      const strong = quietButton('Approve', () => {}, true)
      expect(quiet.className).toBe('quiet')
      expect(strong.className).toBe('quiet strong')
      quiet.click()
      expect(onClick.mock.calls[0]?.[0]).toBeInstanceOf(Event)
    })
  })

  describe('panel toolbar', () => {
    it('posts the state with the workspace once and skips an identical call', () => {
      const fetcher = vi.fn().mockResolvedValue({ ok: true })
      vi.stubGlobal('fetch', fetcher)
      setPanelToolbar({ tab: 'vault', badges: { vault: 2 } })
      setPanelToolbar({ tab: 'vault', badges: { vault: 2 } })
      setPanelToolbar({ back: 'ACME-41' })
      expect(fetcher).toHaveBeenCalledTimes(2)
      expect(fetcher.mock.calls[0]?.[0]).toBe(PANEL_TOOLBAR_PATH)
      expect(JSON.parse(fetcher.mock.calls[0]?.[1].body)).toEqual({
        workspaceId: '',
        tab: 'vault',
        badges: { vault: 2 },
      })
      vi.unstubAllGlobals()
    })

    it('hands the clicks the host dispatches to the page', () => {
      const seen = vi.fn()
      onPanelToolbar(seen)
      window.dispatchEvent(
        new CustomEvent(PANEL_TOOLBAR_EVENT, { detail: { kind: 'tab', id: 'vault' } }),
      )
      window.dispatchEvent(new CustomEvent(PANEL_TOOLBAR_EVENT, { detail: { kind: 'back' } }))
      expect(seen.mock.calls.map((c) => c[0])).toEqual([
        { kind: 'tab', id: 'vault' },
        { kind: 'back' },
      ])
    })
  })

  describe('emptyState', () => {
    it('is one muted line, exactly as given, with nothing else', () => {
      const el = emptyState('沒有狀態圖。')
      expect(el.className).toBe('ostia-empty')
      expect(el.textContent).toBe('沒有狀態圖。')
      expect(el.querySelector('svg, img, h1, h2, code')).toBeNull()
    })

    it('adds no punctuation of its own, so a translation keeps its own', () => {
      for (const text of ['No graphs.', 'No graphs', 'Loading…', 'Empty!']) {
        expect(emptyState(text).textContent).toBe(text)
      }
    })

    it('puts an action inline after the line and carries the attributes given', () => {
      const button = h('button', {}, 'Show Graphs')
      const el = emptyState('Closed in a sandboxed workspace', button, { 'data-empty': 'closed' })
      expect(el.getAttribute('data-empty')).toBe('closed')
      expect(el.lastElementChild).toBe(button)
    })
  })

  describe('listRow', () => {
    it('is a plain row: title and meta on one line, detail under it, actions last', () => {
      const row = listRow({
        title: 'nightly',
        meta: [h('span', {}, 'Enabled')],
        detail: [h('div', {}, 'Builds the app')],
        actions: [h('button', {}, 'Runs')],
        attrs: { 'data-graph': 'nightly' },
      })
      expect(row.tagName).toBe('LI')
      expect(row.className).toBe('ostia-row')
      expect(row.getAttribute('data-graph')).toBe('nightly')
      expect([...row.children].map((c) => c.className || c.tagName)).toEqual([
        'ostia-row-head',
        'DIV',
        'ostia-row-actions',
      ])
      expect(row.querySelector('.ostia-row-title')?.textContent).toBe('nightly')
      expect(row.querySelector('.ostia-row-head')?.textContent).toBe('nightlyEnabled')
    })

    it('has no actions block when it has no actions', () => {
      expect(listRow({ title: 'a' }).querySelector('.ostia-row-actions')).toBeNull()
    })
  })
})
