import { describe, expect, it } from 'vitest'
import { journalLines } from './journalLines'

describe('journalLines', () => {
  it('parses every line the writer finished', () => {
    expect(journalLines('{"type":"a"}\n{"type":"b"}\n')).toEqual([{ type: 'a' }, { type: 'b' }])
  })

  it('leaves out a last line still being appended', () => {
    expect(journalLines('{"type":"a"}\n{"type":"state","state":{"size":"xx')).toEqual([
      { type: 'a' },
    ])
  })

  it('reads an empty journal as no lines', () => {
    expect(journalLines('')).toEqual([])
  })
})
