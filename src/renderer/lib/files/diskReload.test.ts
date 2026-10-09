import { describe, expect, it } from 'vitest'
import { type LineEdit, minimalLineEdit } from './diskReload'

function apply(text: string, edit: LineEdit | null): string {
  if (!edit) return text
  const lines = text.split('\n')
  const offset = (line: number, col: number): number => {
    let o = 0
    for (let i = 0; i < line - 1; i++) o += lines[i].length + 1
    return o + col - 1
  }
  const start = offset(edit.range.startLineNumber, edit.range.startColumn)
  const end = offset(edit.range.endLineNumber, edit.range.endColumn)
  return text.slice(0, start) + edit.text + text.slice(end)
}

describe('minimalLineEdit', () => {
  it('replaces only the lines that differ', () => {
    const cases: [string, string][] = [
      ['a\nb\nc', 'a\nB\nc'],
      ['a\nb\nc', 'a\nb\nc\nd'],
      ['a\nb\nc', 'z\na\nb\nc'],
      ['a\nb\nc', 'a\nc'],
      ['a\nb\nc', ''],
      ['', 'x\ny'],
      ['a\nb', 'a\nb\n'],
    ]
    for (const [from, to] of cases) expect(apply(from, minimalLineEdit(from, to))).toBe(to)
    expect(minimalLineEdit('same', 'same')).toBeNull()
    expect(minimalLineEdit('a\nb\nc', 'a\nB\nc')?.range).toMatchObject({
      startLineNumber: 2,
      endLineNumber: 2,
    })
  })
})
