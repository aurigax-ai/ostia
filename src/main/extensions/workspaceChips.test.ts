import type { InboxEntry, WorkspaceChip } from '@aurigax-ai/ostia-extension-sdk/contract/extensions'
import { describe, expect, it } from 'vitest'
import { firstKnownOwner, inboxEntriesForWindow, workspaceChipsForWindow } from './workspaceChips'

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

describe('inboxEntriesForWindow', () => {
  const owners: Record<string, string> = { w1: 'win-a', w2: 'win-b' }
  const ownerOf = (id: string) => owners[id]
  const entry = (workspaceId: string): InboxEntry => ({
    extId: 'activity',
    workspaceId,
    items: [{ id: 'abcdefghij', text: 'Set the key', at: 1 }],
  })
  const entries = [entry('w1'), entry('w2'), entry('gone')]

  it('gives a window only the inbox entries of the workspaces it owns', () => {
    expect(inboxEntriesForWindow(entries, ownerOf, 'win-a')).toEqual([entry('w1')])
    expect(inboxEntriesForWindow(entries, ownerOf, 'win-b')).toEqual([entry('w2')])
  })

  it('drops the entries of a workspace no window owns', () => {
    expect(inboxEntriesForWindow(entries, ownerOf, 'win-c')).toEqual([])
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
