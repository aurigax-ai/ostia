import { describe, expect, it } from 'vitest'
import { CHAT_EDITS_MAX, applyEdits, parseEdits } from './chatEdits'

describe('parseEdits', () => {
  it('reads the edits list the tool schema describes', () => {
    expect(
      parseEdits({
        path: 'a.ts',
        edits: [
          { old_text: 'a', new_text: 'b' },
          { old_text: 'c', new_text: '', replace_all: true },
        ],
      }),
    ).toEqual([
      { oldText: 'a', newText: 'b' },
      { oldText: 'c', newText: '', replaceAll: true },
    ])
  })

  it('accepts one replacement written without the list', () => {
    expect(parseEdits({ path: 'a.ts', old_text: 'a', new_text: 'b' })).toEqual([
      { oldText: 'a', newText: 'b' },
    ])
  })

  it('refuses an empty target, a missing replacement, no edits and too many', () => {
    expect(parseEdits({ edits: [{ old_text: '', new_text: 'b' }] })).toBeNull()
    expect(parseEdits({ edits: [{ old_text: 'a' }] })).toBeNull()
    expect(parseEdits({ edits: [] })).toBeNull()
    expect(parseEdits({ path: 'a.ts' })).toBeNull()
    expect(parseEdits('a')).toBeNull()
    const many = Array.from({ length: CHAT_EDITS_MAX + 1 }, () => ({
      old_text: 'a',
      new_text: 'b',
    }))
    expect(parseEdits({ edits: many })).toBeNull()
  })
})

describe('applyEdits', () => {
  it('applies each edit to the result of the one before it', () => {
    expect(
      applyEdits('const a = 1\n', [
        { oldText: 'a', newText: 'b' },
        { oldText: 'b = 1', newText: 'b = 2' },
      ]),
    ).toEqual({ ok: true, text: 'const b = 2\n' })
  })

  it('names the edit that matched nothing or more than once', () => {
    expect(applyEdits('x x', [{ oldText: 'y', newText: 'z' }])).toEqual({
      ok: false,
      error: 'no-match',
      edit: 0,
    })
    expect(applyEdits('x x', [{ oldText: 'x', newText: 'z' }])).toEqual({
      ok: false,
      error: 'ambiguous',
      edit: 0,
      count: 2,
    })
  })

  it('counts overlapping matches, so a short target in a run is ambiguous', () => {
    expect(applyEdits('aaa', [{ oldText: 'aa', newText: 'b' }])).toEqual({
      ok: false,
      error: 'ambiguous',
      edit: 0,
      count: 2,
    })
    expect(applyEdits('x\n\n\ny', [{ oldText: '\n\n', newText: '\n' }])).toMatchObject({
      ok: false,
      error: 'ambiguous',
    })
  })

  it("writes new lines with the file's CRLF endings, also when the target is one line", () => {
    expect(applyEdits('a\r\nb\r\n', [{ oldText: 'a', newText: 'a\nnew' }])).toEqual({
      ok: true,
      text: 'a\r\nnew\r\nb\r\n',
    })
    expect(applyEdits('a\nb\n', [{ oldText: 'a', newText: 'a\nnew' }])).toEqual({
      ok: true,
      text: 'a\nnew\nb\n',
    })
  })

  it('does not treat the replacement as a pattern', () => {
    expect(applyEdits('price', [{ oldText: 'price', newText: '$& $1' }])).toEqual({
      ok: true,
      text: '$& $1',
    })
  })
})
