import { describe, expect, it } from 'vitest'
import {
  confirmsGeneratedText,
  countLines,
  pastePreview,
  planDraftPaste,
  planHumanPaste,
} from './pasteGate'

describe('planHumanPaste', () => {
  it('pastes one plain line without asking, tabs kept', () => {
    expect(planHumanPaste('ls -la', true)).toEqual({ text: 'ls -la', confirm: false })
    expect(planHumanPaste('a\tb', true)).toEqual({ text: 'a\tb', confirm: false })
  })

  it('drops a single trailing newline so a copied line does not run by itself', () => {
    expect(planHumanPaste('ls\n', true)).toEqual({ text: 'ls', confirm: false })
    expect(planHumanPaste('ls\r\n', true)).toEqual({ text: 'ls', confirm: false })
  })

  it('strips escape and other control characters from one line instead of asking', () => {
    expect(planHumanPaste('echo \x1b[201~ hi', true)).toEqual({
      text: 'echo [201~ hi',
      confirm: false,
    })
    expect(planHumanPaste('a\x07b\x7fc\x9bd\n', true)).toEqual({ text: 'abcd', confirm: false })
  })

  it('asks before pasting two or more lines and keeps the text whole for the dialog', () => {
    expect(planHumanPaste('a\nb', true)).toEqual({ text: 'a\nb', confirm: true })
    expect(planHumanPaste('a\r\nb\r\n', true)).toEqual({ text: 'a\r\nb\r\n', confirm: true })
    expect(planHumanPaste('a\x1b\nb', true)).toEqual({ text: 'a\x1b\nb', confirm: true })
  })

  it('pastes several lines without asking when confirmation is off, minus control characters', () => {
    expect(planHumanPaste('a\nb', false)).toEqual({ text: 'a\nb', confirm: false })
    expect(planHumanPaste('a\x1b[201~\nb\t', false)).toEqual({
      text: 'a[201~\nb\t',
      confirm: false,
    })
  })

  it('treats one line the same whether confirmation is on or off', () => {
    expect(planHumanPaste('ls\n', false)).toEqual(planHumanPaste('ls\n', true))
    expect(planHumanPaste('x\x1by', false)).toEqual(planHumanPaste('x\x1by', true))
  })
})

describe('confirmsGeneratedText', () => {
  it('asks for any newline, trailing ones included', () => {
    expect(confirmsGeneratedText('ls\n')).toBe(true)
    expect(confirmsGeneratedText('a\r\nb')).toBe(true)
  })

  it('asks for escape and other control characters on one line', () => {
    expect(confirmsGeneratedText('\x1b[201~rm -rf')).toBe(true)
    expect(confirmsGeneratedText('a\x07b')).toBe(true)
    expect(confirmsGeneratedText('a\x7fb')).toBe(true)
  })

  it('runs a single plain line without asking, tabs included', () => {
    expect(confirmsGeneratedText('git status -sb')).toBe(false)
    expect(confirmsGeneratedText('a\tb')).toBe(false)
    expect(confirmsGeneratedText('')).toBe(false)
  })
})

describe('countLines', () => {
  it('counts lines across line endings, ignoring one trailing newline', () => {
    expect(countLines('a')).toBe(1)
    expect(countLines('a\nb\r\nc\rd')).toBe(4)
    expect(countLines('a\nb\n')).toBe(2)
  })
})

describe('pastePreview', () => {
  it('marks control characters as caret tokens and keeps newlines and tabs as text', () => {
    expect(pastePreview('a\x1bb\x07c\nd\te\x7f').parts).toEqual([
      { text: 'a', control: false, offset: 0 },
      { text: '^[', control: true, offset: 1 },
      { text: 'b', control: false, offset: 2 },
      { text: '^G', control: true, offset: 3 },
      { text: 'c\nd\te', control: false, offset: 4 },
      { text: '^?', control: true, offset: 9 },
    ])
  })

  it('shows C1 controls as hex', () => {
    expect(pastePreview('\x9b').parts).toEqual([{ text: '\\x9b', control: true, offset: 0 }])
  })

  it('truncates very long text and says so', () => {
    const long = pastePreview('x'.repeat(30000))
    expect(long.truncated).toBe(true)
    expect(long.parts[0].text.length).toBe(20000)
    expect(pastePreview('short').truncated).toBe(false)
  })
})

describe('planDraftPaste', () => {
  it('strips control characters and a trailing newline but keeps the lines of a draft', () => {
    expect(planDraftPaste('echo hi\x1b[201~\n')).toBe('echo hi[201~')
    expect(planDraftPaste('one\ntwo\x07\n')).toBe('one\ntwo\n')
  })
})
