import { describe, expect, it } from 'vitest'
import { electronAccelerator, parseAppMenuSpec } from './appMenu'
import { parseChord } from './chordSpec'

const section = (items: unknown[]) => ({ label: 'X', items })

function spec(file: unknown[] = []): unknown {
  return { file: section(file), view: section([]), go: section([]), help: section([]) }
}

describe('parseAppMenuSpec', () => {
  it('keeps commands, labels, accelerators and separators', () => {
    const parsed = parseAppMenuSpec(
      spec([
        { command: 'workspace.new', label: 'New Workspace', accelerator: 'Cmd+T' },
        { separator: true },
        { command: 'workspace.save', label: 'Save Workspace' },
      ]),
    )
    expect(parsed?.file.items).toEqual([
      { command: 'workspace.new', label: 'New Workspace', accelerator: 'Cmd+T' },
      { separator: true },
      { command: 'workspace.save', label: 'Save Workspace' },
    ])
  })

  it('drops an accelerator that is not a plain key combination', () => {
    const parsed = parseAppMenuSpec(spec([{ command: 'a.b', label: 'A', accelerator: 'Cmd+T; x' }]))
    expect(parsed?.file.items).toEqual([{ command: 'a.b', label: 'A' }])
  })

  it('rejects a spec with a missing section, a bad command id or an empty label', () => {
    expect(parseAppMenuSpec(null)).toBeNull()
    expect(parseAppMenuSpec({ file: section([]) })).toBeNull()
    expect(parseAppMenuSpec(spec([{ command: '../x', label: 'A' }]))).toBeNull()
    expect(parseAppMenuSpec(spec([{ command: 'a.b', label: ' ' }]))).toBeNull()
    expect(
      parseAppMenuSpec(spec(Array.from({ length: 41 }, () => ({ separator: true })))),
    ).toBeNull()
  })
})

describe('electronAccelerator', () => {
  const accel = (text: string) => {
    const chord = parseChord(text, true)
    return chord ? electronAccelerator(chord) : 'unparsed'
  }

  it('writes chords the way Electron menus expect', () => {
    expect(accel('Cmd+Shift+X')).toBe('Shift+Cmd+X')
    expect(accel('Cmd+Ctrl+]')).toBe('Ctrl+Cmd+]')
    expect(accel('Ctrl+Shift+Tab')).toBe('Ctrl+Shift+Tab')
    expect(accel('Cmd+Ctrl+Left')).toBe('Ctrl+Cmd+Left')
    expect(accel('Cmd+\\')).toBe('Cmd+\\')
    expect(accel('Cmd+=')).toBe('Cmd+=')
    expect(accel('Cmd+,')).toBe('Cmd+,')
  })
})
