import { emptyState, h, listRow, panelToolbar } from '@aurigax-ai/ostia-extension-sdk/panel'
import { describe, expect, it, vi } from 'vitest'

describe('panel kit', () => {
  describe('panelToolbar', () => {
    it('is nothing at all when it has neither a Back button nor actions, so no title row is left', () => {
      expect(panelToolbar({})).toBeNull()
      expect(panelToolbar({ actions: [] })).toBeNull()
    })

    it('is a Back button alone, with no title, that calls back', () => {
      const onClick = vi.fn()
      const bar = panelToolbar({ back: { label: 'Back', onClick } })
      expect(bar?.className).toBe('ostia-toolbar')
      expect(bar?.querySelector('h1, h2')).toBeNull()
      const button = bar?.querySelector('button') as HTMLButtonElement
      expect(button.textContent).toBe('Back')
      button.click()
      expect(onClick).toHaveBeenCalledTimes(1)
    })

    it('puts the actions after the Back button', () => {
      const action = h('button', {}, 'Refresh')
      const bar = panelToolbar({ back: { label: 'Back', onClick: () => {} }, actions: [action] })
      expect([...(bar?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).toEqual([
        'Back',
        'Refresh',
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
