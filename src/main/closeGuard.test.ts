import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { on: vi.fn() } }))

const { parseRunningGroups } = await import('./closeGuard')

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
