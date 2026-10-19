import { describe, expect, it } from 'vitest'
import { lineField, tsvLine } from './lineField'

describe('tsvLine', () => {
  it('keeps one line with one tab per field whatever the free text holds', () => {
    const line = tsvLine(['p1', 'fix\ttabs\nand lines\r', 'bell\u0007esc\u001b[0m', 'del\u007f'])
    expect(line).toBe('p1\tfix\\ttabs\\nand lines\\r\tbell\\x07esc\\x1b[0m\tdel\\x7f')
    expect(line.split('\n')).toHaveLength(1)
    expect(line.split('\t')).toHaveLength(4)
  })

  it('escapes C1 controls, reordering controls and line separators', () => {
    expect(lineField('a\u009bb\u202ec\u2066d\u061ce\u2028f')).toBe(
      'a\\x9bb\\u202ec\\u2066d\\u061ce\\u2028f',
    )
  })

  it('keeps CJK, Persian with ZWNJ, Hebrew with RLM and a ZWJ emoji as they are', () => {
    for (const text of ['控制面板.md', 'می\u200cخواهم.txt', 'שלום\u200f.md', '👨\u200d💻 dev']) {
      expect(lineField(text)).toBe(text)
    }
  })

  it('prints a missing field as empty and leaves other text alone', () => {
    expect(lineField(undefined)).toBe('')
    expect(lineField('控制面 ✓ a\\b')).toBe('控制面 ✓ a\\b')
  })
})
