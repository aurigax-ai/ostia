import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

const { parseRunningGroups, withScratchFiles } = await import('./closeGuard')

describe('parseRunningGroups', () => {
  it('keeps well-formed groups from every window and clips what it shows', () => {
    const groups = parseRunningGroups([
      { workspaceId: 'w1', workspace: 'api', commands: ['sleep 100', 7], files: ['/a.ts'] },
      { workspaceId: 3, workspace: 'bad' },
      'nope',
      { workspaceId: 'w2', workspace: 'web', commands: ['x'.repeat(2000)] },
    ])
    expect(groups).toEqual([
      { workspaceId: 'w1', workspace: 'api', commands: ['sleep 100'], files: ['/a.ts'] },
      { workspaceId: 'w2', workspace: 'web', commands: ['x'.repeat(512)], files: [] },
    ])
  })

  it('treats anything but an array as nothing running', () => {
    expect(parseRunningGroups(undefined)).toEqual([])
    expect(parseRunningGroups({ workspaceId: 'w1' })).toEqual([])
  })
})

describe('withScratchFiles', () => {
  it('adds the scratch folder file count from main and drops groups with nothing to ask about', () => {
    const groups = parseRunningGroups([
      { workspaceId: 'w1', workspace: 'Scratch', commands: [], files: [], scratchFiles: 999 },
      { workspaceId: 'w2', workspace: 'Scratch 2', commands: [], files: [] },
      { workspaceId: 'w3', workspace: 'api', commands: ['sleep 100'], files: [] },
    ])
    const counts: Record<string, number> = { w1: 2, w2: 0 }
    expect(withScratchFiles(groups, (id) => counts[id] ?? 0)).toEqual([
      { workspaceId: 'w1', workspace: 'Scratch', commands: [], files: [], scratchFiles: 2 },
      { workspaceId: 'w3', workspace: 'api', commands: ['sleep 100'], files: [] },
    ])
  })
})
