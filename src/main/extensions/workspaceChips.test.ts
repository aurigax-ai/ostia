import { describe, expect, it } from 'vitest'
import type { WorkspaceChip } from '../../shared/extensions'
import { firstKnownOwner, workspaceChipsForWindow } from './workspaceChips'

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

describe('firstKnownOwner', () => {
  it('asks each lookup in order and takes the first answer', () => {
    const owner = firstKnownOwner(
      (id) => (id === 'reported' ? 'win-a' : undefined),
      (id) => (id === 'has-pane' ? 'win-b' : undefined),
      (id) => (id === 'reported' || id === 'just-added' ? 'win-c' : undefined),
    )
    expect(owner('reported')).toBe('win-a')
    expect(owner('has-pane')).toBe('win-b')
    expect(owner('unknown')).toBeUndefined()
  })

  it('delivers the chip of a workspace that was only just added, with no pane and no report yet', () => {
    const owner = firstKnownOwner(
      () => undefined,
      () => undefined,
      (id) => (id === 'just-added' ? 'win-c' : undefined),
    )
    expect(workspaceChipsForWindow([chip('just-added', 'branch')], owner, 'win-c')).toEqual([
      chip('just-added', 'branch'),
    ])
  })
})
