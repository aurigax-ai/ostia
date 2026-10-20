import {
  emptyState,
  h,
  listRow,
  panelTab,
  panelToolbar,
  quietButton,
} from '@aurigax-ai/ostia-extension-sdk/panel'
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

  describe('tabs and quiet buttons', () => {
    it('puts the tabs before the actions in a tab bar, and is a bar with tabs alone', () => {
      const onClick = vi.fn()
      const bar = panelToolbar({
        tabs: [panelTab('Rules', true, onClick), panelTab('Prompts', false, () => {})],
        actions: [h('button', {}, 'Add')],
      })
      expect(bar?.className).toBe('ostia-toolbar ostia-tabs')
      expect([...(bar?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).toEqual([
        'Rules',
        'Prompts',
        'Add',
      ])
      expect(panelToolbar({ tabs: [panelTab('Rules', true, () => {})] })).not.toBeNull()
    })

    it('marks only the current tab and calls its handler', () => {
      const onClick = vi.fn()
      const current = panelTab('Rules', true, onClick)
      const other = panelTab('Prompts', false, () => {})
      expect(current.getAttribute('aria-current')).toBe('page')
      expect(other.hasAttribute('aria-current')).toBe(false)
      expect(current.className).toBe('tab')
      current.click()
      expect(onClick).toHaveBeenCalledTimes(1)
    })

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
