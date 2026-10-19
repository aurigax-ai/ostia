import { describe, expect, it } from 'vitest'
import { lineField, tsvLine } from './lineField'

describe('tsvLine', () => {
  it('keeps one line with one tab per field whatever the free text holds', () => {
    const line = tsvLine(['p1', 'fix\ttabs\nand lines\r', 'bell\u0007esc\u001b[0m', 'del\u007f'])
    expect(line).toBe('p1\tfix\\ttabs\\nand lines\\r\tbell\\x07esc\\x1b[0m\tdel\\x7f')
    expect(line.split('\n')).toHaveLength(1)
    expect(line.split('\t')).toHaveLength(4)
  })

  it('prints a missing field as empty and leaves other text alone', () => {
    expect(lineField(undefined)).toBe('')
    expect(lineField('控制面 ✓ a\\b')).toBe('控制面 ✓ a\\b')
  })
})
