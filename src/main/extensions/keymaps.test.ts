import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { KeymapContribution } from '../../shared/keymap'
import { readManifest } from './extensionManifest'
import {
  type KeymapDeps,
  type KeymapSource,
  describeSkipped,
  keymapFor,
  loadKeymap,
} from './keymaps'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function extension(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-keymap-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  return dir
}

const contribution = (extra: Partial<KeymapContribution> = {}): KeymapContribution => ({
  id: 'cmux',
  label: 'cmux',
  path: 'keys.json',
  ...extra,
})

function deps(sources: KeymapSource[], platform = 'darwin') {
  return {
    keymaps: () => sources,
    platform,
    onError: vi.fn<KeymapDeps['onError']>(),
    onSkipped: vi.fn<KeymapDeps['onSkipped']>(),
  }
}

describe('loadKeymap', () => {
  it('reads the bindings file and reports the entries it skipped', () => {
    const dir = extension({
      'keys.json': JSON.stringify({
        bindings: { 'pane.splitRight': 'Cmd+D', 'pane.zoom': 'Ctrl+X', find: null },
      }),
    })
    expect(loadKeymap({ extId: 'keys', dir, keymap: contribution() }, true)).toEqual({
      ok: true,
      keymap: {
        extId: 'keys',
        id: 'cmux',
        label: 'cmux',
        bindings: { 'pane.splitRight': 'Cmd+D', find: null },
        skipped: [{ command: 'pane.zoom', value: 'Ctrl+X', problem: 'needs-modifier' }],
      },
    })
  })

  it('refuses a missing file, a file that is not JSON and one without bindings', () => {
    const dir = extension({ 'bad.json': '{ nope', 'empty.json': '{}' })
    const load = (path: string) =>
      loadKeymap({ extId: 'k', dir, keymap: contribution({ path }) }, true)
    expect(load('keys.json')).toEqual({ ok: false, error: 'keys.json: missing' })
    expect(load('bad.json')).toEqual({ ok: false, error: 'bad.json: not valid JSON' })
    expect(load('empty.json')).toEqual({
      ok: false,
      error: 'empty.json: must be a JSON object with a "bindings" object',
    })
  })

  it('never follows a symlink or leaves the extension folder', () => {
    const outside = extension({ 'keys.json': JSON.stringify({ bindings: {} }) })
    const dir = extension({})
    symlinkSync(join(outside, 'keys.json'), join(dir, 'link.json'))
    const load = (path: string) =>
      loadKeymap({ extId: 'k', dir, keymap: contribution({ path }) }, true)
    expect(load('link.json')).toEqual({ ok: false, error: 'link.json: symlink refused' })
    expect(load(join('..', outside.split('/').pop() ?? '', 'keys.json'))).toMatchObject({
      ok: false,
      error: expect.stringContaining('outside the extension'),
    })
  })

  it('refuses a file larger than 64 KiB', () => {
    const dir = extension({
      'keys.json': JSON.stringify({ bindings: {}, pad: 'x'.repeat(70_000) }),
    })
    expect(loadKeymap({ extId: 'k', dir, keymap: contribution() }, true)).toEqual({
      ok: false,
      error: 'keys.json: larger than 65536 bytes',
    })
  })
})

describe('keymapFor', () => {
  const file = JSON.stringify({ bindings: { 'pane.splitRight': 'Cmd+D', 'pane.zoom': 'Ctrl+X' } })

  it('loads a keymap by "<extension id>/<keymap id>" and logs what it skipped', () => {
    const dir = extension({ 'keys.json': file })
    const d = deps([{ extId: 'keys', dir, keymap: contribution() }])
    const res = keymapFor('keys/cmux', d)
    expect(res.ok && res.keymap.bindings).toEqual({ 'pane.splitRight': 'Cmd+D' })
    expect(d.onSkipped).toHaveBeenCalledWith('keys/cmux', [
      { command: 'pane.zoom', value: 'Ctrl+X', problem: 'needs-modifier' },
    ])
    expect(d.onError).not.toHaveBeenCalled()
  })

  it('offers nothing for an unknown ref, another extension’s id or a non-string', () => {
    const dir = extension({ 'keys.json': file })
    const d = deps([{ extId: 'keys', dir, keymap: contribution() }])
    for (const ref of ['keys/other', 'other/cmux', 'cmux', 7, null]) {
      expect(keymapFor(ref, d), String(ref)).toMatchObject({ ok: false })
    }
    expect(d.onError).not.toHaveBeenCalled()
  })

  it('keeps a keymap for another platform from loading', () => {
    const dir = extension({ 'keys.json': file })
    const source = { extId: 'keys', dir, keymap: contribution({ platform: 'darwin' }) }
    expect(keymapFor('keys/cmux', deps([source], 'linux'))).toEqual({
      ok: false,
      error: 'no enabled extension offers it on this computer',
    })
    expect(keymapFor('keys/cmux', deps([source], 'darwin')).ok).toBe(true)
  })

  it('validates chords for the platform it runs on', () => {
    const dir = extension({ 'keys.json': JSON.stringify({ bindings: { find: 'Ctrl+Shift+G' } }) })
    const source = { extId: 'keys', dir, keymap: contribution() }
    const linux = keymapFor('keys/cmux', deps([source], 'linux'))
    const mac = keymapFor('keys/cmux', deps([source], 'darwin'))
    expect(linux.ok && linux.keymap.bindings).toEqual({ find: 'Ctrl+Shift+G' })
    expect(mac.ok && mac.keymap.skipped.map((s) => s.problem)).toEqual(['needs-modifier'])
  })

  it('logs a file it cannot read', () => {
    const dir = extension({})
    const d = deps([{ extId: 'keys', dir, keymap: contribution() }])
    expect(keymapFor('keys/cmux', d)).toEqual({ ok: false, error: 'keys.json: missing' })
    expect(d.onError).toHaveBeenCalledWith('keys/cmux', 'keys.json: missing')
  })

  it('describes skipped entries in one log line', () => {
    expect(
      describeSkipped([
        { command: 'pane.zoom', value: 'Ctrl+X', problem: 'ctrl-key' },
        { command: 'find', value: 'Escape', problem: 'escape' },
      ]),
    ).toBe('pane.zoom "Ctrl+X" (ctrl-key), find "Escape" (escape)')
  })
})

describe('the macOS keymap shipped with the app', () => {
  const dir = join(__dirname, '..', '..', 'extensions', 'keymap-macos')

  it('offers cmux and iTerm2 on macOS only, and every entry of each loads there', () => {
    const res = readManifest(dir)
    if (!res.ok) throw new Error(res.error)
    const keymaps = res.manifest.contributes.keymaps ?? []
    expect(keymaps.map((k) => [k.id, k.platform])).toEqual([
      ['cmux', 'darwin'],
      ['iterm2', 'darwin'],
    ])
    for (const keymap of keymaps) {
      const ref = `keymap-macos/${keymap.id}`
      const source = { extId: res.manifest.id, dir, keymap }
      const mac = keymapFor(ref, deps([source], 'darwin'))
      if (!mac.ok) throw new Error(mac.error)
      expect(mac.keymap.skipped, ref).toEqual([])
      const raw = JSON.parse(readFileSync(join(dir, keymap.path), 'utf8'))
      expect(Object.keys(mac.keymap.bindings), ref).toEqual(Object.keys(raw.bindings))
      expect(keymapFor(ref, deps([source], 'linux')).ok, ref).toBe(false)
    }
  })
})
