import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'
import type { ActivityEvent, ActivityHost } from './hookEvent'
import en from './locales/en.json'
import type { RowEnv } from './rows'
import {
  agentLimitKey,
  type Limits,
  panelModel,
  STREAM_LIMIT_KEY,
  STREAM_PAGE,
  TURN_PAGE,
} from './view'

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/?locale=en' })
vi.stubGlobal('window', dom.window)
vi.stubGlobal('document', dom.window.document)
vi.stubGlobal('location', dom.window.location)
vi.stubGlobal('DOMParser', dom.window.DOMParser)

const { panelTranslator } = await import('@aurigax-ai/ostia-extension-sdk/panel')
const { createListView } = await import('./rows')

let clock = 0

function prompt(pane: string, text: string): ActivityEvent {
  clock += 10
  return {
    v: 2,
    t: clock,
    id: 'eventidaaa',
    pane,
    agent: 'claude',
    session: 's',
    kind: 'prompt',
    text,
  }
}

function host(pane: string, t: number, extra: Partial<ActivityHost>): ActivityHost {
  return { v: 2, t, id: `host${t}`, pane, kind: 'host', host: 'started', ...extra }
}

function setup() {
  document.body.innerHTML = '<main id="list"></main>'
  const list = document.getElementById('list') as HTMLElement
  const watched: HTMLElement[] = []
  const asked: HTMLElement[] = []
  const open = new Set<string>()
  const env: RowEnv = {
    t: panelTranslator({ en: en.messages }),
    now: () => 1_000_000,
    focusAgent: () => {},
    focusNote: () => {},
    isOpen: (key) => open.has(key),
    setOpen: (key, on) => void (on ? open.add(key) : open.delete(key)),
    paneNote: () => undefined,
    noteFailure: () => undefined,
    watchMore: (el) => void watched.push(el),
    loadMore: (el) => void asked.push(el),
  }
  const show = createListView(list, env)
  let version = 0
  const render = (
    records: (ActivityEvent | ActivityHost)[],
    options: { limits?: Limits; showActivity?: boolean } = {},
  ) => {
    const showActivity = options.showActivity ?? true
    const model = panelModel({
      showActivity,
      workspace: { workspaceId: 'w', name: 'w' },
      panes: [{ paneId: 'p' }, { paneId: 'sender' }],
      limits: options.limits,
      events: () => records,
    })
    show({
      kind: 'workspace',
      workspace: model.workspace as NonNullable<typeof model.workspace>,
      showActivity,
      version: String(version++),
    })
  }
  const texts = (selector: string) =>
    [...list.querySelectorAll<HTMLElement>(selector)].map((el) => el.textContent)
  return { list, render, texts, watched, asked }
}

describe('prompt rows', () => {
  it.each([
    ['<pasted_content id="a739">', 'Pasted text'],
    ['<task-notification>', 'Task notification'],
    ['<system-reminder>', 'System reminder'],
    ['<ostia-bus-messages>', 'Message from another pane'],
    ['<message id="m1" from="sender" at="2026-10-20T08:00:00.000Z">', 'Message from Claude Code 2'],
  ])('shows %s as a readable label, never the tag', (raw, label) => {
    const s = setup()
    s.render([prompt('p', raw), prompt('sender', 'hello')])
    const row = s.list.querySelector('.agent[data-pane="p"] .turn .prompt') as HTMLElement
    expect(row.textContent).toBe(label)
    expect(row.hasAttribute('data-wrapper')).toBe(true)
    expect(s.list.innerHTML).not.toContain('&lt;')
    expect(s.list.textContent).not.toContain('<')
  })

  it('shows an ordinary prompt as typed', () => {
    const s = setup()
    s.render([prompt('p', 'fix the cart total')])
    const row = s.list.querySelector('.prompt') as HTMLElement
    expect(row.textContent).toBe('fix the cart total')
    expect(row.hasAttribute('data-wrapper')).toBe(false)
  })
})

describe('workspace event rows', () => {
  it('shows a bulk of one kind as one counted row', () => {
    const s = setup()
    s.render(
      Array.from({ length: 12 }, (_, i) =>
        host(`pane${i}`, 1000 + i * 100, { host: 'folder', folder: '…/r2' }),
      ),
    )
    expect(s.texts('.stream-text')).toEqual(['12 panes moved to …/r2'])
  })

  it('shows a single event as before', () => {
    const s = setup()
    s.render([host('pane1', 1000, { host: 'folder', folder: '…/r2' })])
    expect(s.texts('.stream-text')).toEqual(['Pane moved to …/r2'])
  })
})

describe('a collapsed row of panes', () => {
  const burst = Array.from({ length: 3 }, (_, i) =>
    host(`pane${i}`, 1000 + i * 100, { host: 'folder', folder: '…/r2' }),
  )

  it('lists each pane when expanded and hides them again, keeping the row', () => {
    const s = setup()
    s.render(burst)
    const row = s.list.querySelector('.stream-row') as HTMLElement
    const toggle = row.querySelector('.bulk-toggle') as HTMLButtonElement
    expect(toggle.hidden).toBe(false)
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(s.texts('.bulk-pane')).toEqual([])
    toggle.click()
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(s.texts('.bulk-pane')).toEqual(['Pane', 'Pane 2', 'Pane 3'])
    s.render([...burst, host('pane3', 1300, { host: 'folder', folder: '…/r2' })])
    expect(s.list.querySelector('.stream-row')).toBe(row)
    expect(s.texts('.bulk-pane')).toHaveLength(4)
    expect(s.texts('.stream-text')).toEqual(['4 panes moved to …/r2'])
    toggle.click()
    expect(s.texts('.bulk-pane')).toEqual([])
  })

  it('has no toggle on a row of one pane', () => {
    const s = setup()
    s.render(burst.slice(0, 1))
    expect((s.list.querySelector('.bulk-toggle') as HTMLElement).hidden).toBe(true)
  })
})

describe('loading older rows', () => {
  it('offers a Show older button that asks for the next page, as the scroll watcher does', () => {
    const s = setup()
    s.render(Array.from({ length: TURN_PAGE * 2 }, (_, i) => prompt('p', `turn ${i}`)))
    const more = s.list.querySelector('.agent .more') as HTMLButtonElement
    expect(more.tagName).toBe('BUTTON')
    expect(more.textContent).toBe('Show older')
    more.click()
    expect(s.asked).toEqual([more])
  })

  const turns = (count: number) => Array.from({ length: count }, (_, i) => prompt('p', `turn ${i}`))

  it('builds only a page of earlier turns and offers the rest when scrolled to', () => {
    const s = setup()
    s.render(turns(TURN_PAGE * 4))
    expect(s.texts('.agent .turn .prompt')).toHaveLength(TURN_PAGE + 1)
    const more = s.list.querySelector('.agent .more') as HTMLElement
    expect(more.hidden).toBe(false)
    expect(more.dataset.more).toBe(agentLimitKey('p'))
    expect(more.dataset.loaded).toBe(String(TURN_PAGE))
    expect(s.watched).toContain(more)
  })

  it('patches the rows already built in place when the next page arrives', () => {
    const s = setup()
    const records = turns(TURN_PAGE * 4)
    s.render(records)
    const before = [...s.list.querySelectorAll('.agent .turn')]
    const more = s.list.querySelector('.agent .more') as HTMLElement
    const watchedBefore = s.watched.length
    s.render(records, { limits: { [agentLimitKey('p')]: TURN_PAGE * 2 } })
    const after = [...s.list.querySelectorAll('.agent .turn')]
    expect(after).toHaveLength(TURN_PAGE * 2 + 1)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(more.dataset.loaded).toBe(String(TURN_PAGE * 2))
    expect(s.watched.length).toBeGreaterThan(watchedBefore)
  })

  it('hides the sentinel once everything is loaded and in the recap view', () => {
    const s = setup()
    const records = turns(TURN_PAGE + 2)
    s.render(records)
    const more = s.list.querySelector('.agent .more') as HTMLElement
    expect(more.hidden).toBe(false)
    s.render(records, { showActivity: false })
    expect(more.hidden).toBe(true)
    s.render(records, { limits: { [agentLimitKey('p')]: TURN_PAGE + 10 } })
    expect(more.hidden).toBe(true)
  })

  it('pages the workspace events the same way', () => {
    const s = setup()
    const spread = Array.from({ length: STREAM_PAGE * 3 }, (_, i) =>
      host('pane1', (i + 1) * 60_000, { host: i % 2 === 0 ? 'started' : 'closed' }),
    )
    s.render(spread)
    expect(s.texts('.stream-text')).toHaveLength(STREAM_PAGE)
    const more = s.list.querySelector('.stream .more') as HTMLElement
    expect(more.hidden).toBe(false)
    expect(more.dataset.more).toBe(STREAM_LIMIT_KEY)
  })
})

const css = readFileSync(new URL('./panel.css', import.meta.url), 'utf8')

function rules(): { selector: string; body: string }[] {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selector: m[1].trim(),
    body: m[2],
  }))
}

const GROUPS = /^\.(agent|stream|workspace|notes)(?![\w-])/

describe('the spacing between groups', () => {
  it('draws no line around or between agent groups, workspace events or notes, so no two lines can stack', () => {
    const drawn = rules().filter(
      ({ selector, body }) =>
        selector.split(',').some((part) => GROUPS.test(part.trim())) && /\bborder/.test(body),
    )
    expect(drawn.map((rule) => rule.selector)).toEqual([])
  })

  it('spaces the groups with one gap on the workspace column', () => {
    const column = rules().find(({ selector }) => selector === '.workspace')
    expect(column?.body).toMatch(/display:\s*flex/)
    expect(column?.body).toMatch(/gap:\s*\d+px/)
  })
})
