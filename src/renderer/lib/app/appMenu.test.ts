import type { CommandDef } from '@/commands/registry'
import { commands } from '@/commands/registry'
import { useUIStore } from '@/stores/uiStore'
import { en } from '@shared/app/dict'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SSH_CONNECT_ITEM, buildAppMenuSpec, runAppMenuItem } from './appMenu'

function registry(ids: string[], hidden: string[] = []) {
  const map = new Map<string, CommandDef<unknown, unknown>>(
    ids.map((id) => [id, { id, title: `T ${id}`, hidden: hidden.includes(id), run: () => {} }]),
  )
  return (id: string) => map.get(id)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('buildAppMenuSpec', () => {
  it('lists only registered, visible commands, with their shortcut, and no stray separators', () => {
    const spec = buildAppMenuSpec(
      en,
      registry(['workspace.new', 'tab.new', 'workspace.save', 'pane.zoom'], ['tab.new']),
      (id) => (id === 'pane.zoom' ? 'Shift+Cmd+X' : null),
    )
    expect(spec.file.label).toBe('File')
    expect(spec.file.items).toEqual([
      { command: 'workspace.new', label: 'T workspace.new' },
      { separator: true },
      { command: 'workspace.save', label: 'T workspace.save' },
    ])
    expect(spec.view.items).toEqual([
      { command: 'pane.zoom', label: 'T pane.zoom', accelerator: 'Shift+Cmd+X' },
    ])
    expect(spec.go.items).toEqual([])
    expect(spec.help.items).toEqual([])
  })

  it('puts New Window in the File menu with its shortcut', () => {
    const spec = buildAppMenuSpec(en, registry(['workspace.new', 'window.new']), (id) =>
      id === 'window.new' ? 'Shift+Cmd+N' : null,
    )
    expect(spec.file.items).toEqual([
      { command: 'workspace.new', label: 'T workspace.new' },
      { command: 'window.new', label: 'T window.new', accelerator: 'Shift+Cmd+N' },
    ])
  })

  it('shows Find in Page with the find shortcut', () => {
    const spec = buildAppMenuSpec(en, registry(['browser.find']), (id) =>
      id === 'find' ? 'Cmd+F' : null,
    )
    expect(spec.view.items).toEqual([
      { command: 'browser.find', label: 'T browser.find', accelerator: 'Cmd+F' },
    ])
  })

  it('offers Connect to SSH Host only when the SSH extension command exists', () => {
    const without = buildAppMenuSpec(en, registry([]), () => null)
    expect(without.file.items).toEqual([])
    const withSsh = buildAppMenuSpec(en, registry(['ssh.connect']), () => null)
    expect(withSsh.file.items).toEqual([
      { command: SSH_CONNECT_ITEM, label: 'Connect to SSH Host…' },
    ])
  })
})

describe('runAppMenuItem', () => {
  it('runs a registered command and ignores unknown ones', () => {
    const has = vi.spyOn(commands, 'has').mockImplementation((id) => id === 'pane.zoom')
    const exec = vi.spyOn(commands, 'exec').mockResolvedValue({ ok: true, result: undefined })
    runAppMenuItem('pane.zoom')
    runAppMenuItem('nope.nothing')
    expect(has).toHaveBeenCalled()
    expect(exec).toHaveBeenCalledTimes(1)
    expect(exec).toHaveBeenCalledWith('pane.zoom')
  })

  it('opens the palette on the SSH connect command for the SSH item', () => {
    vi.spyOn(commands, 'list').mockReturnValue([
      { id: 'ssh.connect', title: 'SSH: Connect to Host…', run: () => {} },
    ])
    const openPalette = vi.fn()
    vi.spyOn(useUIStore, 'getState').mockReturnValue({
      ...useUIStore.getState(),
      openPalette,
    })
    runAppMenuItem(SSH_CONNECT_ITEM)
    expect(openPalette).toHaveBeenCalledWith('search', 'SSH: Connect to Host…')
  })
})
