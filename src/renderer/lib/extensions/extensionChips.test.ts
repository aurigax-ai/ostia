import type { PaneChip, WorkspaceChip } from '@shared/extensions'
import { describe, expect, it } from 'vitest'
import { chipsForWorkspace, promptExtensionChips } from './extensionChips'

const catalog = [
  { extId: 'git', extName: 'Git', id: 'branch', title: 'Git branch' },
  { extId: 'git', extName: 'Git', id: 'diff-stats', title: 'Git diff stats' },
  { extId: 'env', extName: 'Env', id: 'venv', title: 'Python env' },
]

const workspaceChip = (workspaceId: string, id: string, text: string): WorkspaceChip => ({
  extId: 'git',
  id,
  workspaceId,
  text,
  tone: 'neutral',
})

const paneChip = (paneId: string, extId: string, id: string, text: string): PaneChip => ({
  extId,
  id,
  paneId,
  text,
  tone: 'neutral',
})

describe('chipsForWorkspace', () => {
  it('returns one workspace chips in catalog order with their titles', () => {
    const chips = [
      workspaceChip('w1', 'diff-stats', '+5 -1'),
      workspaceChip('w2', 'branch', 'dev'),
      workspaceChip('w1', 'branch', 'main'),
    ]
    expect(chipsForWorkspace(chips, catalog, 'w1').map((c) => [c.title, c.text])).toEqual([
      ['Git branch', 'main'],
      ['Git diff stats', '+5 -1'],
    ])
    expect(chipsForWorkspace(chips, catalog, null)).toEqual([])
  })
})

describe('promptExtensionChips', () => {
  it("gives a pane's prompt its own chips plus its workspace's, and the pane's win on a clash", () => {
    const shown = promptExtensionChips(
      [paneChip('p1', 'env', 'venv', '.venv'), paneChip('p1', 'git', 'branch', 'pane-branch')],
      [
        workspaceChip('w1', 'branch', 'main'),
        workspaceChip('w1', 'diff-stats', '+2 -0'),
        workspaceChip('w2', 'diff-stats', 'other'),
      ],
      catalog,
      'p1',
      'w1',
    )
    expect(shown.map((c) => `${c.extId}.${c.id}=${c.text}`)).toEqual([
      'git.branch=pane-branch',
      'env.venv=.venv',
      'git.diff-stats=+2 -0',
    ])
  })
})
