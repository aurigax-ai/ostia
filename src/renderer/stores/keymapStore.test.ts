import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chordLabel } from '@/lib/keys/chords'
import type { ExtensionInfo } from '@shared/extensions'
import type { KeymapInfo } from '@shared/keymap'
import type { KeymapLoad } from '@shared/keymapFile'
import { act, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useExtensionsStore } from './extensionsStore'
import { keymapChoices, keymapProvider, startKeymapSync, useKeymapStore } from './keymapStore'
import { useSettingsStore } from './settingsStore'

const initialSettings = useSettingsStore.getState()
const initialExtensions = useExtensionsStore.getState()
const initialKeymap = useKeymapStore.getState()

function provider(id: string, keymaps: KeymapInfo[], enabled = true): ExtensionInfo {
  return {
    id,
    name: `${id} keys`,
    version: '1.0.0',
    description: '',
    category: 'other',
    builtin: true,
    enabled,
    status: 'idle',
    requested: [],
    granted: [],
    unapproved: [],
    commands: [],
    panel: null,
    paneChips: [],
    workspaceChips: [],
    settings: [],
    settingValues: {},
    settingsPage: null,
    assist: [],
    secrets: [],
    secretsSet: [],
    iconThemes: [],
    languages: [],
    keymaps,
    languageServers: [],
    agentSkills: [],
    agentHooks: [],
  }
}

const loaded = (
  extId: string,
  id: string,
  bindings: Record<string, string | null>,
): KeymapLoad => ({
  ok: true,
  keymap: { extId, id, label: id, bindings, skipped: [] },
})

const load = () => vi.mocked(window.ostia.keymaps.load)
let stop: (() => void) | null = null

afterEach(() => {
  stop?.()
  stop = null
  useSettingsStore.setState(initialSettings, true)
  useExtensionsStore.setState(initialExtensions, true)
  useKeymapStore.setState(initialKeymap, true)
})

describe('keymapChoices', () => {
  it('lists keymaps of enabled extensions offered on this platform', () => {
    const list = [
      provider('keys', [
        { id: 'any', label: 'Any' },
        { id: 'mac', label: 'Mac', platform: 'darwin' },
        { id: 'tux', label: 'Tux', platform: 'linux' },
      ]),
      provider('off', [{ id: 'any', label: 'Off' }], false),
    ]
    expect(keymapChoices(list, 'linux').map((c) => c.ref)).toEqual(['keys/any', 'keys/tux'])
    expect(keymapChoices(list, 'darwin').map((c) => c.ref)).toEqual(['keys/any', 'keys/mac'])
    expect(keymapProvider('keys/mac', list, 'linux')).toBeNull()
    expect(keymapProvider('off/any', list, 'linux')).toBeNull()
    expect(keymapProvider('keys/any', list, 'linux')?.ext.id).toBe('keys')
  })

  it('offers the shipped cmux and iTerm2 keymaps under App shortcuts on macOS only', () => {
    const dir = join(__dirname, '../../extensions/keymap-macos')
    const manifest = JSON.parse(readFileSync(join(dir, 'ostia.json'), 'utf8'))
    const list = [provider(manifest.id, manifest.contributes.keymaps)]
    expect(keymapChoices(list, 'darwin').map((c) => [c.ref, c.label])).toEqual([
      ['keymap-macos/cmux', 'macOS (cmux)'],
      ['keymap-macos/iterm2', 'macOS (iTerm2)'],
    ])
    expect(keymapChoices(list, 'linux')).toEqual([])
  })
})

describe('startKeymapSync', () => {
  it('leaves the defaults alone while the setting is null', () => {
    useExtensionsStore.setState({ list: [provider('keys', [{ id: 'any', label: 'Any' }])] })
    stop = startKeymapSync()
    expect(useSettingsStore.getState().keymap).toBeNull()
    expect(load()).not.toHaveBeenCalled()
    expect(useKeymapStore.getState().loaded).toBeNull()
    expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+\\')
  })

  it('treats an id no enabled extension offers here like null', async () => {
    useExtensionsStore.setState({
      list: [
        provider('keys', [{ id: 'mac', label: 'Mac', platform: 'darwin' }]),
        provider('off', [{ id: 'any', label: 'Off' }], false),
      ],
    })
    stop = startKeymapSync()
    for (const ref of ['nobody/here', 'keys/mac', 'off/any']) {
      act(() => useSettingsStore.getState().setKeymap(ref))
      await Promise.resolve()
      expect(useKeymapStore.getState().loaded, ref).toBeNull()
      expect(chordLabel('pane.splitRight', false), ref).toBe('Ctrl+Alt+\\')
    }
    expect(load()).not.toHaveBeenCalled()
  })

  it('loads the chosen keymap, drops it when its extension is disabled and reloads on enable', async () => {
    load().mockResolvedValue(loaded('keys', 'any', { 'pane.splitRight': 'Ctrl+Alt+D' }))
    const on = provider('keys', [{ id: 'any', label: 'Any' }])
    useExtensionsStore.setState({ list: [on] })
    stop = startKeymapSync()
    act(() => useSettingsStore.getState().setKeymap('keys/any'))
    await waitFor(() => expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+D'))
    expect(load()).toHaveBeenCalledWith('keys/any')

    act(() => useExtensionsStore.setState({ list: [{ ...on, enabled: false }] }))
    expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+\\')
    act(() => useExtensionsStore.setState({ list: [on] }))
    await waitFor(() => expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+D'))
    expect(load()).toHaveBeenCalledTimes(2)
  })

  it('keeps the error of a keymap that fails to load and uses the defaults', async () => {
    load().mockResolvedValue({ ok: false, error: 'keys.json: missing' })
    useExtensionsStore.setState({ list: [provider('keys', [{ id: 'any', label: 'Any' }])] })
    useSettingsStore.setState({ keymap: 'keys/any' })
    stop = startKeymapSync()
    await waitFor(() => expect(useKeymapStore.getState().error).toBe('keys.json: missing'))
    expect(useKeymapStore.getState().loaded).toBeNull()
    expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+\\')
  })

  it('ignores a load that finishes after the choice changed', async () => {
    let finish: (res: KeymapLoad) => void = () => {}
    load().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    load().mockResolvedValueOnce(loaded('keys', 'two', { 'pane.splitRight': 'Ctrl+Alt+T' }))
    useExtensionsStore.setState({
      list: [
        provider('keys', [
          { id: 'one', label: 'One' },
          { id: 'two', label: 'Two' },
        ]),
      ],
    })
    stop = startKeymapSync()
    act(() => useSettingsStore.getState().setKeymap('keys/one'))
    act(() => useSettingsStore.getState().setKeymap('keys/two'))
    await waitFor(() => expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+T'))
    finish(loaded('keys', 'one', { 'pane.splitRight': 'Ctrl+Alt+O' }))
    await Promise.resolve()
    expect(chordLabel('pane.splitRight', false)).toBe('Ctrl+Alt+T')
  })
})
