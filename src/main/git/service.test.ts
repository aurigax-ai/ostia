import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type CoreItems, DEFAULT_GIT_SETTINGS, type GitSettings } from '../../shared/git'
import type { PaneEntry, WorkspaceEntry } from '../paneList'
import { GIT_CHANGED_CHANNEL, GIT_ITEMS_CHANNEL, GitService, type Repo } from './service'

const workspace = (workspaceId: string, workDir: string): WorkspaceEntry => ({
  workspaceId,
  name: workspaceId,
  kind: 'terminal',
  workDir,
  state: 'idle',
})

function repoOn(head: string, changed = false): Repo {
  return {
    root: `/repos/${head}`,
    status: {
      branch: { oid: 'a'.repeat(40), head, upstream: null, ahead: 0, behind: 0 },
      changes: changed ? [{ path: 'a.txt', area: 'unstaged', code: 'M' }] : [],
    },
  }
}

describe('GitService', () => {
  let settings: GitSettings
  let repos: Map<string, Repo>
  const sent: { windowId: string; channel: string; payload: unknown }[] = []
  const listWorkspaces = vi.fn<() => Promise<WorkspaceEntry[]>>()
  const listPanes = vi.fn<() => Promise<PaneEntry[]>>()
  const repoAt = vi.fn<(cwd: string) => Promise<Repo | null>>()
  const diffStats = vi.fn<(repo: Repo) => Promise<string>>()
  let service: GitService

  const items = (windowId: string): CoreItems | undefined =>
    sent.filter((m) => m.windowId === windowId && m.channel === GIT_ITEMS_CHANNEL).at(-1)
      ?.payload as CoreItems | undefined
  const settle = async (ms = 0): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms)
  }

  beforeEach(() => {
    vi.useFakeTimers()
    settings = { ...DEFAULT_GIT_SETTINGS }
    repos = new Map([
      ['/w/one', repoOn('main', true)],
      ['/w/two', repoOn('feature')],
    ])
    sent.length = 0
    listWorkspaces
      .mockReset()
      .mockResolvedValue([
        workspace('one', '/w/one'),
        workspace('two', '/w/two'),
        workspace('plain', '/tmp'),
      ])
    listPanes.mockReset().mockResolvedValue([])
    repoAt.mockReset().mockImplementation(async (cwd) => repos.get(cwd) ?? null)
    diffStats.mockReset().mockResolvedValue('1 • +2 -1')
    service = new GitService({
      settings: () => settings,
      listWorkspaces,
      listPanes,
      send: (windowId, channel, payload) => sent.push({ windowId, channel, payload }),
      repoAt,
      diffStats,
    })
  })

  afterEach(() => {
    service.stop()
    vi.useRealTimers()
  })

  it('reads nothing and arms no timer while no window shows a git item', async () => {
    service.activity('command.finished')
    service.setFocused(false)
    service.setFocused(true)
    service.settingsChanged()
    await settle(60_000)
    expect(service.polling).toBe(false)
    expect(service.pending).toBe(false)
    expect(listWorkspaces).not.toHaveBeenCalled()
    expect(repoAt).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('reads only the workspaces a window shows and sends that window their branch and chips', async () => {
    service.watch('w1', ['one', 'plain'])
    await settle()
    expect(repoAt.mock.calls.map(([cwd]) => cwd).sort()).toEqual(['/tmp', '/w/one'])
    expect(items('w1')).toEqual({
      sidebar: [
        {
          extId: 'git',
          workspaceId: 'one',
          key: 'branch',
          text: 'main',
          icon: 'git-branch',
          tone: 'neutral',
          kind: 'location',
        },
      ],
      paneChips: [],
      workspaceChips: [
        {
          extId: 'git',
          workspaceId: 'one',
          id: 'branch',
          text: 'main',
          tone: 'neutral',
          command: 'git.show',
        },
        { extId: 'git', workspaceId: 'one', id: 'diff-stats', text: '1 • +2 -1', tone: 'neutral' },
      ],
    })
    expect(items('w2')).toBeUndefined()
  })

  it('gives each window only what it shows', async () => {
    service.watch('w1', ['one'])
    service.watch('w2', ['two'])
    await settle()
    expect(items('w1')?.sidebar.map((i) => i.text)).toEqual(['main'])
    expect(items('w2')?.sidebar.map((i) => i.text)).toEqual(['feature'])
  })

  it('polls while focused, pauses on blur and reads at once on focus', async () => {
    service.watch('w1', ['one'])
    await settle()
    const afterFirst = repoAt.mock.calls.length
    await settle(settings.pollSeconds * 1000)
    expect(repoAt.mock.calls.length).toBe(afterFirst + 1)
    service.setFocused(false)
    expect(service.polling).toBe(false)
    await settle(settings.pollSeconds * 5000)
    expect(repoAt.mock.calls.length).toBe(afterFirst + 1)
    service.setFocused(true)
    await settle()
    expect(repoAt.mock.calls.length).toBe(afterFirst + 2)
  })

  it('reads again after a command finishes in a pane, debounced', async () => {
    service.watch('w1', ['one'])
    await settle()
    const before = repoAt.mock.calls.length
    service.activity('command.finished')
    service.activity('cwd.changed')
    service.activity('command.started')
    await settle(300)
    expect(repoAt.mock.calls.length).toBe(before + 1)
  })

  it('stops and clears what it showed once the last window stops showing git', async () => {
    service.watch('w1', ['one'])
    service.watch('w2', ['two'])
    await settle()
    service.watch('w1', [])
    await settle()
    expect(items('w1')).toEqual({ sidebar: [], paneChips: [], workspaceChips: [] })
    expect(service.polling).toBe(true)
    service.windowGone('w2')
    expect(service.polling).toBe(false)
    expect(service.pending).toBe(false)
    const reads = repoAt.mock.calls.length
    await settle(120_000)
    expect(repoAt.mock.calls.length).toBe(reads)
  })

  it('stops when the human turns git off and starts again when turned on', async () => {
    service.watch('w1', ['one'])
    await settle()
    settings = { ...settings, enabled: false }
    service.settingsChanged()
    expect(service.polling).toBe(false)
    expect(items('w1')).toEqual({ sidebar: [], paneChips: [], workspaceChips: [] })
    settings = { ...settings, enabled: true }
    service.settingsChanged()
    await settle()
    expect(items('w1')?.sidebar).toHaveLength(1)
  })

  it('leaves the diff stats chip out and does not count lines when the setting is off', async () => {
    settings = { ...settings, showDiffStats: false }
    service.settingsChanged()
    service.watch('w1', ['one'])
    await settle()
    expect(diffStats).not.toHaveBeenCalled()
    expect(items('w1')?.workspaceChips.map((c) => c.id)).toEqual(['branch'])
  })

  it('tells watching windows when a repository changed, and at once after a write', async () => {
    const changed = (): number => sent.filter((m) => m.channel === GIT_CHANGED_CHANNEL).length
    service.watch('w1', ['one'])
    await settle()
    expect(changed()).toBe(1)
    await settle(settings.pollSeconds * 1000)
    expect(changed()).toBe(1)
    repos.set('/w/one', repoOn('main'))
    await settle(settings.pollSeconds * 1000)
    expect(changed()).toBe(2)
    service.touched()
    expect(changed()).toBe(3)
  })

  it('follows a new poll interval', async () => {
    service.watch('w1', ['one'])
    await settle()
    settings = { ...settings, pollSeconds: 60 }
    service.settingsChanged()
    await settle()
    const before = repoAt.mock.calls.length
    await settle(30_000)
    expect(repoAt.mock.calls.length).toBe(before)
    await settle(30_000)
    expect(repoAt.mock.calls.length).toBe(before + 1)
  })
})
