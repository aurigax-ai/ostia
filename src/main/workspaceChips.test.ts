import { describe, expect, it } from 'vitest'
import type { WorkspaceChip } from '../shared/extensions'
import { workspaceChipsForWindow } from './workspaceChips'

const chip = (workspaceId: string, id: string): WorkspaceChip => ({
  extId: 'git',
  id,
  workspaceId,
  text: id,
  tone: 'neutral',
})

describe('workspaceChipsForWindow', () => {
  const owners: Record<string, string> = { w1: 'win-a', w2: 'win-b' }
  const ownerOf = (id: string) => owners[id]
  const chips = [chip('w1', 'branch'), chip('w2', 'branch'), chip('gone', 'branch')]

  it('gives a window only the chips of the workspaces it owns', () => {
    expect(workspaceChipsForWindow(chips, ownerOf, 'win-a')).toEqual([chip('w1', 'branch')])
    expect(workspaceChipsForWindow(chips, ownerOf, 'win-b')).toEqual([chip('w2', 'branch')])
  })

  it('drops chips of a workspace no window owns', () => {
    expect(workspaceChipsForWindow(chips, ownerOf, 'win-c')).toEqual([])
  })
})
