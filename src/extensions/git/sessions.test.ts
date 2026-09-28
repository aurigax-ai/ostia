import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PaneInfo, SessionInfo } from '../sdk'
import { SessionCwds } from './sessions'

function session(id: string, workDir: string, activePaneId?: string): SessionInfo {
  return { sessionId: id, name: id, kind: 'terminal', workDir, state: 'idle', activePaneId }
}

function pane(paneId: string, sessionId: string, kind: string, cwd?: string): PaneInfo {
  return { paneId, sessionId, kind, title: kind, cwd, running: false, blockCount: 0 }
}

describe('SessionCwds', () => {
  it('uses the active pane cwd of each session', () => {
    const cwds = new SessionCwds().resolve(
      [session('s1', '/w1', 'p2'), session('s2', '/w2', 'p3')],
      [
        pane('p1', 's1', 'terminal', '/a'),
        pane('p2', 's1', 'terminal', '/b'),
        pane('p3', 's2', 'editor', '/c'),
      ],
    )
    expect(cwds).toEqual(
      new Map([
        ['s1', '/b'],
        ['s2', '/c'],
      ]),
    )
  })

  it('falls back to the last active terminal when a cwd-less panel is focused', () => {
    const tracker = new SessionCwds()
    const panes = [
      pane('p1', 's1', 'terminal', '/a'),
      pane('p2', 's1', 'terminal', '/b'),
      pane('p3', 's1', 'extension'),
    ]
    tracker.resolve([session('s1', '/w', 'p2')], panes)
    expect(tracker.resolve([session('s1', '/w', 'p3')], panes).get('s1')).toBe('/b')
  })

  it('falls back to the first terminal with a cwd, then to the workDir with ~ expanded', () => {
    const cwds = new SessionCwds().resolve(
      [session('s1', '/w', 'p9'), session('s2', '~/proj')],
      [pane('p1', 's1', 'extension'), pane('p2', 's1', 'terminal', '/t')],
    )
    expect(cwds.get('s1')).toBe('/t')
    expect(cwds.get('s2')).toBe(join(homedir(), 'proj'))
  })
})
