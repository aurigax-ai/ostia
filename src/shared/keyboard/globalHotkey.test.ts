import { describe, expect, it } from 'vitest'
import { parseGlobalHotkey, toAccelerator } from './globalHotkey'

describe('toAccelerator', () => {
  it('turns a chord into an Electron accelerator', () => {
    expect(toAccelerator('Ctrl+Alt+Space')).toBe('Ctrl+Alt+Space')
    expect(toAccelerator('ctrl + shift + p')).toBe('Ctrl+Shift+P')
    expect(toAccelerator('Mod+`')).toBe('CommandOrControl+`')
    expect(toAccelerator('Super+F12')).toBe('Super+F12')
    expect(toAccelerator('Cmd+Option+Up')).toBe('Command+Alt+Up')
  })

  it('refuses a bare key, Shift alone, a repeated or unknown modifier and unknown keys', () => {
    for (const bad of [
      'Space',
      'F1',
      'Shift+A',
      'Ctrl+Ctrl+A',
      'Hyper+A',
      'Ctrl+',
      'Ctrl+Foo',
      '',
    ]) {
      expect(toAccelerator(bad), bad).toBeNull()
    }
    expect(toAccelerator(7)).toBeNull()
    expect(toAccelerator(`Ctrl+${'A'.repeat(80)}`)).toBeNull()
  })
})

describe('parseGlobalHotkey', () => {
  it('keeps a valid chord as typed and drops an invalid one', () => {
    expect(parseGlobalHotkey(' Ctrl+Alt+Space ')).toBe('Ctrl+Alt+Space')
    expect(parseGlobalHotkey('Space')).toBe('')
    expect(parseGlobalHotkey(null)).toBe('')
  })
})
