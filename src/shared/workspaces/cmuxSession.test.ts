import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type CmuxLayout,
  type CmuxSession,
  nearestGroupColor,
  parseCmuxSession,
} from './cmuxSession'

const FIXTURE = resolve(__dirname, '../../../test/fixtures/cmux/session-com.cmuxterm.app.json')

function recorded(): unknown {
  return JSON.parse(readFileSync(FIXTURE, 'utf8'))
}

function parse(raw: unknown): CmuxSession {
  const parsed = parseCmuxSession(raw)
  if (!('session' in parsed)) throw new Error(`not parsed: ${parsed.error}`)
  return parsed.session
}

function shape(layout: CmuxLayout): unknown {
  if (layout.type === 'pane') return layout.surfaces.map((s) => s.title ?? s.type)
  return { [layout.direction]: [shape(layout.first), shape(layout.second)] }
}

function depthOf(layout: CmuxLayout): number {
  if (layout.type === 'pane') return 0
  return 1 + Math.max(depthOf(layout.first), depthOf(layout.second))
}

function session(workspace: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    version: 1,
    windows: [{ tabManager: { workspaces: [workspace] } }],
    ...extra,
  }
}

const terminal = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'terminal',
  directory: '/home/u/app',
  terminal: {},
  ...extra,
})

describe('parseCmuxSession on a recorded cmux session', () => {
  it('reads every window and workspace with its name and folder', () => {
    const { windows } = parse(recorded())

    expect(windows.map((w) => w.workspaces.map((ws) => [ws.title, ws.directory]))).toEqual([
      [
        ['Office', '/Users/alex/Code'],
        ['App', '/Users/alex/Code/acme/app'],
        ['Client work', '/Users/alex/Code/work'],
        ['Editor', '/Users/alex/Code/acme'],
        ['Research', '/Users/alex/Code/acme'],
      ],
      [['Ops', '/Users/alex/Code/home/infra']],
    ])
  })

  it('keeps the split tree, its orientation and every tab in order', () => {
    const app = parse(recorded()).windows[0].workspaces[1]

    expect(shape(app.layout)).toEqual({
      horizontal: [
        ['Server', 'Refactor', 'terminal'],
        { vertical: [['Vite App'], ['markdown', 'workspaceTodo', 'Review']] },
      ],
    })
    expect(app.layout.type === 'split' && app.layout.divider).toBe(0.6)
  })

  it('reads the selected tab, focused pane and each surface’s folder, page and file', () => {
    const app = parse(recorded()).windows[0].workspaces[1]
    if (app.layout.type !== 'split' || app.layout.first.type !== 'pane') throw new Error('shape')
    const [server, codex, shell] = app.layout.first.surfaces
    const right = app.layout.second
    if (right.type !== 'split' || right.first.type !== 'pane' || right.second.type !== 'pane') {
      throw new Error('shape')
    }

    expect(app.layout.first.selected).toBe(1)
    expect(codex).toMatchObject({
      directory: '/Users/alex/Code/acme/app/src',
      agent: 'codex',
      resume: { agent: 'codex', id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b' },
      focused: true,
    })
    expect(server).toMatchObject({ title: 'Server', scrollback: true })
    expect(shell.title).toBeUndefined()
    expect(right.first.surfaces[0]).toMatchObject({
      type: 'browser',
      url: 'http://localhost:5173/',
      browserHistory: true,
    })
    expect(right.second.surfaces[0]).toMatchObject({
      type: 'markdown',
      filePath: '/Users/alex/Code/acme/app/README.md',
    })
    expect(right.second.surfaces[2]).toMatchObject({ agent: 'gemini' })
    expect(right.second.surfaces[2].resume).toBeUndefined()
  })

  it('reads the pin, group, description and a recorded Claude session', () => {
    const { windows } = parse(recorded())
    const [office, app, , , research] = windows[0].workspaces
    if (office.layout.type !== 'pane') throw new Error('shape')

    expect(app).toMatchObject({ pinned: true, description: 'Web client and API' })
    expect(app.group).toBeUndefined()
    expect(research.group).toBe('Acme')
    expect(windows[1].workspaces[0].group).toBe('Infra')
    expect(office.layout.surfaces.map((s) => s.resume?.agent ?? null)).toEqual([null, 'claude'])
    expect(office.pinned).toBeUndefined()
  })

  it('flags canvas mode and remote terminals', () => {
    const ops = parse(recorded()).windows[1].workspaces[0]
    if (ops.layout.type !== 'split' || ops.layout.second.type !== 'pane') throw new Error('shape')

    expect(ops.canvas).toBe(true)
    expect(ops.layout.second.surfaces[0]).toMatchObject({ remote: true, directory: '/srv/app' })
  })
})

describe('parseCmuxSession on damaged or foreign input', () => {
  it('refuses anything that is not a version 1 cmux session', () => {
    expect(parseCmuxSession(null)).toEqual({ error: 'invalid' })
    expect(parseCmuxSession([])).toEqual({ error: 'invalid' })
    expect(parseCmuxSession({ v: 1, workspaces: [] })).toEqual({ error: 'invalid' })
    expect(parseCmuxSession({ version: 1 })).toEqual({ error: 'invalid' })
    expect(parseCmuxSession({ version: 2, windows: [] })).toEqual({ error: 'unsupported-version' })
  })

  it('skips a workspace without an absolute folder and a window without a tab manager', () => {
    const raw = {
      version: 1,
      windows: [
        { frame: {} },
        {
          tabManager: {
            workspaces: [
              { currentDirectory: 'relative', panels: [] },
              { currentDirectory: '/home/u/ok', panels: [] },
              'junk',
            ],
          },
        },
      ],
    }

    expect(parse(raw).windows.map((w) => w.workspaces.map((ws) => ws.directory))).toEqual([
      ['/home/u/ok'],
    ])
  })

  it('keeps the other half of a split whose side is malformed, and drops unknown panel ids', () => {
    const raw = session({
      currentDirectory: '/home/u/app',
      panels: [terminal('a')],
      layout: {
        type: 'split',
        split: {
          orientation: 'vertical',
          dividerPosition: 0.3,
          first: { type: 'pane', pane: { panelIds: ['a', 'missing'], selectedPanelId: 'a' } },
          second: { type: 'grid' },
        },
      },
    })

    expect(parse(raw).windows[0].workspaces[0].layout).toEqual({
      type: 'pane',
      surfaces: [{ type: 'terminal', directory: '/home/u/app' }],
      selected: 0,
    })
  })

  it('uses each panel once, falls back to an even divider and to the first tab', () => {
    const raw = session({
      currentDirectory: '/home/u/app',
      panels: [terminal('a'), terminal('b')],
      layout: {
        type: 'split',
        split: {
          orientation: 'horizontal',
          dividerPosition: 7,
          first: { type: 'pane', pane: { panelIds: ['a', 'b'], selectedPanelId: 'gone' } },
          second: { type: 'pane', pane: { panelIds: ['a'] } },
        },
      },
    })
    const layout = parse(raw).windows[0].workspaces[0].layout

    expect(layout).toMatchObject({
      type: 'split',
      divider: 0.5,
      first: { type: 'pane', selected: 0 },
      second: { type: 'pane', surfaces: [] },
    })
  })

  it('refuses an unknown split orientation and gives an empty pane for a missing layout', () => {
    const odd = session({
      currentDirectory: '/home/u/app',
      panels: [terminal('a')],
      layout: {
        type: 'split',
        split: {
          orientation: 'diagonal',
          dividerPosition: 0.5,
          first: { type: 'pane', pane: { panelIds: ['a'] } },
          second: { type: 'pane', pane: { panelIds: [] } },
        },
      },
    })

    expect(parse(odd).windows[0].workspaces[0].layout).toEqual({
      type: 'pane',
      surfaces: [],
      selected: 0,
    })
  })

  it('stops at absurdly deep layouts instead of overflowing the stack', () => {
    const leaf = { type: 'pane', pane: { panelIds: [] } }
    let layout: Record<string, unknown> = { type: 'pane', pane: { panelIds: ['a'] } }
    for (let i = 0; i < 10_000; i++) {
      layout = {
        type: 'split',
        split: { orientation: 'vertical', dividerPosition: 0.5, first: layout, second: leaf },
      }
    }
    const raw = session({ currentDirectory: '/home/u/app', panels: [terminal('a')], layout })
    const parsed = parse(raw).windows[0].workspaces[0].layout

    expect(depthOf(parsed)).toBeGreaterThan(0)
    expect(depthOf(parsed)).toBeLessThanOrEqual(33)
  })

  it('ignores an agent session id that cannot be resumed safely and a non-web browser url', () => {
    const raw = session({
      currentDirectory: '/home/u/app',
      panels: [
        terminal('a', { terminal: { agent: { kind: 'claude', sessionId: '; rm -rf ~' } } }),
        { id: 'b', type: 'browser', browser: { urlString: 'javascript:alert(1)' } },
      ],
      layout: { type: 'pane', pane: { panelIds: ['a', 'b'] } },
    })
    const layout = parse(raw).windows[0].workspaces[0].layout
    if (layout.type !== 'pane') throw new Error('shape')

    expect(layout.surfaces[0]).toEqual({
      type: 'terminal',
      directory: '/home/u/app',
      agent: 'claude',
    })
    expect(layout.surfaces[1]).toEqual({ type: 'browser' })
  })
})

describe('nearestGroupColor', () => {
  it('picks the palette colour with the closest hue', () => {
    expect(nearestGroupColor('#1565C0')).toBe('blue')
    expect(nearestGroupColor('#E53935')).toBe('red')
    expect(nearestGroupColor('#FB8C00')).toBe('orange')
    expect(nearestGroupColor('#FDD835')).toBe('yellow')
    expect(nearestGroupColor('#43A047')).toBe('green')
    expect(nearestGroupColor('#00ACC1')).toBe('teal')
    expect(nearestGroupColor('#8E24AA')).toBe('purple')
    expect(nearestGroupColor('#EC407A')).toBe('pink')
  })

  it('leaves grey, black, white and malformed values uncoloured', () => {
    for (const value of ['#808080', '#000000', '#FFFFFF', '#7A7F80', '#0A0F14', 'blue', '#12', 7]) {
      expect(nearestGroupColor(value)).toBeUndefined()
    }
  })
})

describe('parseCmuxSession workspace colour', () => {
  it('reads customColor as the nearest palette colour', () => {
    const ws = (customColor: unknown) =>
      parse(session({ currentDirectory: '/home/u/app', customColor })).windows[0].workspaces[0]
    expect(ws('#1565C0').color).toBe('blue')
    expect(ws('#888888').color).toBeUndefined()
    expect(ws(undefined).color).toBeUndefined()
  })
})
