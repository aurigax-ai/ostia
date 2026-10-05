import { describe, expect, it } from 'vitest'
import { KEYMAP_COMMAND_MAX, parseKeymapBindings } from './keymapFile'

describe('parseKeymapBindings', () => {
  it('keeps chords and nulls, trimmed, in a map without a prototype', () => {
    const res = parseKeymapBindings(
      { bindings: { 'pane.splitRight': ' Cmd+D ', 'view.toggleRail': null } },
      true,
    )
    expect(res).toEqual({
      ok: true,
      bindings: { 'pane.splitRight': 'Cmd+D', 'view.toggleRail': null },
      skipped: [],
    })
    if (res.ok) expect(Object.getPrototypeOf(res.bindings)).toBeNull()
  })

  it('skips and reports every entry it cannot use, keeping the rest', () => {
    const res = parseKeymapBindings(
      {
        bindings: {
          'palette.toggle': 'Ctrl+Shift+P',
          'pane.zoom': 'Ctrl+X',
          find: 'Escape',
          'pane.close': 'Shift+W',
          'workspace.next': 'Hyper+K',
          'palette.toggle.extra': 7,
          'view.zoomIn': 'Ctrl+Alt+1-9',
          'workspace.goto': 'Ctrl+Shift+K',
          'pane.focusLeft': 'Ctrl+Left',
          'pane.splitDown': 'Shift+Tab',
        },
      },
      false,
    )
    if (!res.ok) throw new Error(res.error)
    expect(res.bindings).toEqual({ 'palette.toggle': 'Ctrl+Shift+P' })
    expect(res.skipped).toEqual([
      { command: 'pane.zoom', value: 'Ctrl+X', problem: 'ctrl-key' },
      { command: 'find', value: 'Escape', problem: 'escape' },
      { command: 'pane.close', value: 'Shift+W', problem: 'needs-modifier' },
      { command: 'workspace.next', value: 'Hyper+K', problem: 'invalid' },
      { command: 'palette.toggle.extra', value: '7', problem: 'invalid' },
      { command: 'view.zoomIn', value: 'Ctrl+Alt+1-9', problem: 'digit-range' },
      { command: 'workspace.goto', value: 'Ctrl+Shift+K', problem: 'digit-range' },
      { command: 'pane.focusLeft', value: 'Ctrl+Left', problem: 'arrow' },
      { command: 'pane.splitDown', value: 'Shift+Tab', problem: 'tab' },
    ])
  })

  it('checks chords for the platform it loads on', () => {
    const raw = { bindings: { 'palette.toggle': 'Ctrl+Shift+P', 'pane.splitRight': 'Cmd+D' } }
    const mac = parseKeymapBindings(raw, true)
    const linux = parseKeymapBindings(raw, false)
    expect(mac.ok && mac.bindings).toEqual({ 'pane.splitRight': 'Cmd+D' })
    expect(mac.ok && mac.skipped).toEqual([
      { command: 'palette.toggle', value: 'Ctrl+Shift+P', problem: 'needs-modifier' },
    ])
    expect(linux.ok && linux.bindings).toEqual(raw.bindings)
  })

  it('never copies prototype keys and refuses unusable command ids', () => {
    const res = parseKeymapBindings(
      JSON.parse(
        `{"bindings": {"__proto__": "Cmd+P", "constructor": "Cmd+O", "": "Cmd+E", "${'x'.repeat(KEYMAP_COMMAND_MAX + 1)}": "Cmd+L", "find": "Cmd+G"}}`,
      ),
      true,
    )
    if (!res.ok) throw new Error(res.error)
    expect(res.bindings).toEqual({ find: 'Cmd+G' })
    expect(res.skipped.map((s) => s.problem)).toEqual(['invalid', 'invalid', 'invalid', 'invalid'])
    expect(({} as Record<string, unknown>).find).toBeUndefined()
  })

  it('refuses a file that is not an object with a bindings object', () => {
    for (const raw of [null, [], 'x', {}, { bindings: [] }, { bindings: 'Cmd+K' }]) {
      expect(parseKeymapBindings(raw, true), JSON.stringify(raw)).toEqual({
        ok: false,
        error: 'must be a JSON object with a "bindings" object',
      })
    }
  })
})
