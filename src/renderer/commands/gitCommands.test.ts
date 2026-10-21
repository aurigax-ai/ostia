import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { commands } from '@/commands/registry'
import { useDiffStore } from '@/stores/files/diffStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { registerGitCommands } from './gitCommands'

const CHANGES = {
  ok: true,
  data: {
    root: '/r',
    changes: [
      { path: 'a.ts', area: 'staged', code: 'M' },
      { path: 'a.ts', area: 'unstaged', code: 'M' },
      { path: 'b.ts', area: 'unstaged', code: 'M' },
    ],
  },
} as never

describe('git changed-file commands', () => {
  beforeAll(() => {
    registerGitCommands()
    commands.setContextProvider(() => ({
      activeWorkspaceId: useWorkspacesStore.getState().activeWorkspaceId,
      activePaneId: 'd1',
    }))
  })
  afterAll(() => {
    commands.setContextProvider(() => ({ activeWorkspaceId: null, activePaneId: null }))
    for (const id of ['git.show', 'git.showGraph', 'git.blameFile']) commands.unregister(id)
    commands.unregister('git.openNextChange')
    commands.unregister('git.openPreviousChange')
  })
  beforeEach(() => {
    useWorkspacesStore.setState({
      workspaces: [{ id: 'w1', name: 'home', kind: 'terminal', workDir: '/r', state: 'idle' }],
      activeWorkspaceId: 'w1',
    })
    vi.mocked(window.ostia.git.changes).mockResolvedValue(CHANGES)
    vi.mocked(window.ostia.git.openChange).mockClear()
  })

  it('opens the next and previous change of the diff in the pane, telling staged from unstaged', async () => {
    useDiffStore.getState().set('d1', {
      title: 'a.ts (Index)',
      original: '',
      modified: '',
      path: '/r/a.ts',
      area: 'staged',
    })
    expect(await commands.exec('git.openNextChange')).toMatchObject({ ok: true })
    expect(window.ostia.git.openChange).toHaveBeenLastCalledWith('w1', '/r/a.ts', 'unstaged')
    await commands.exec('git.openPreviousChange', { paneId: 'd1' })
    expect(window.ostia.git.openChange).toHaveBeenLastCalledWith('w1', '/r/b.ts', 'unstaged')
  })

  it('reads the changes again on every run, so it follows what Git has now', async () => {
    useDiffStore.getState().set('d1', {
      title: 'a.ts',
      original: '',
      modified: '',
      path: '/r/a.ts',
      area: 'unstaged',
    })
    await commands.exec('git.openNextChange')
    expect(window.ostia.git.openChange).toHaveBeenLastCalledWith('w1', '/r/b.ts', 'unstaged')
    vi.mocked(window.ostia.git.changes).mockResolvedValue({
      ok: true,
      data: { root: '/r', changes: [{ path: 'a.ts', area: 'unstaged', code: 'M' }] },
    } as never)
    window.ostia.git.openChange = vi.fn().mockResolvedValue({ ok: true })
    await commands.exec('git.openNextChange')
    expect(window.ostia.git.openChange).not.toHaveBeenCalled()
  })

  it('refuses a pane that is not the diff of a Git change', async () => {
    useDiffStore.getState().set('d1', { title: 'x ↔ y', original: '', modified: '', path: '/r/y' })
    expect(await commands.exec('git.openNextChange')).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining('not a diff of a Git change') },
    })
  })
})
