import { describe, expect, it } from 'vitest'
import { HUMAN_PROMPT_WINDOW_MS, humanInputSource, PaneInput } from './paneInput'

function pane(): { input: PaneInput; advance: (ms: number) => void } {
  let clock = 1_000
  return {
    input: new PaneInput(() => clock),
    advance: (ms) => {
      clock += ms
    },
  }
}

describe('PaneInput', () => {
  it('counts a line the human typed and submitted', () => {
    const { input } = pane()
    input.note('fix the cart', 'key')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).not.toBeNull()
  })

  it('does not count a line an agent sent with pane send', () => {
    const { input } = pane()
    input.note('fix the cart', null)
    input.note('\r', null)
    expect(input.claimHumanPrompt('x')).toBeNull()
  })

  it('does not count the human pressing Enter on text an agent typed', () => {
    const { input } = pane()
    input.note('rm -rf build', null)
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).toBeNull()
  })

  it('does not count a line the human edited after an agent typed into it', () => {
    const { input } = pane()
    input.note('always run', null)
    input.note('please', 'key')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).toBeNull()
  })

  it('counts a fresh line once the human cleared what an agent typed', () => {
    const { input } = pane()
    input.note('always run', null)
    input.note('\x15', 'key')
    input.note('my own words', 'key')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).not.toBeNull()
  })

  it('counts a bracketed paste the human made and does not submit on its newlines', () => {
    const { input } = pane()
    input.note('\x1b[200~line one\rline two\x1b[201~', 'paste')
    expect(input.claimHumanPrompt('x')).toBeNull()
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).not.toBeNull()
  })

  it('does not count a multi-line paste an agent sent, even though its newlines look like Enter', () => {
    const { input } = pane()
    input.note('\x1b[200~line one\rline two\x1b[201~', null)
    input.note('\r', null)
    expect(input.claimHumanPrompt('x')).toBeNull()
  })

  it('does not let an unterminated agent paste swallow the human’s Enter', () => {
    const { input } = pane()
    input.note('\x1b[200~half', null)
    input.note('typed', 'key')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).toBeNull()
    input.note('again', 'key')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).not.toBeNull()
  })

  it('ignores cursor keys, focus reports and mouse reports written without a human source', () => {
    const { input } = pane()
    input.note('fix it', 'key')
    input.note('\x1b[I\x1b[A\x1bOB\x1b[<0;10;5M\x1b[M !!', null)
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).not.toBeNull()
  })

  it('stops counting after the window, and a later agent line replaces a human one', () => {
    const { input, advance } = pane()
    input.note('fix it\r', 'key')
    advance(HUMAN_PROMPT_WINDOW_MS)
    expect(input.claimHumanPrompt('first')).not.toBeNull()
    advance(1)
    expect(input.claimHumanPrompt('second')).toBeNull()
    input.note('fix it\r', 'key')
    input.note('other\r', null)
    expect(input.claimHumanPrompt('x')).toBeNull()
  })

  it('hands each extension a submitted line once, so a forged call after the real hook gets nothing', () => {
    const { input } = pane()
    input.note('fix it\r', 'key')
    expect(input.claimHumanPrompt('skills')).not.toBeNull()
    expect(input.claimHumanPrompt('activity')).not.toBeNull()
    expect(input.claimHumanPrompt('skills')).toBeNull()
    input.note('and this\r', 'key')
    expect(input.claimHumanPrompt('skills')).not.toBeNull()
  })

  it('hands over the text the human typed, so the hook cannot say anything else', () => {
    const { input } = pane()
    input.note('fix the ', 'key')
    input.note('cart', 'key')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).toBe('fix the cart')
  })

  it('follows backspace and a cleared line, and takes a paste as typed', () => {
    const { input } = pane()
    input.note('fix the cax\x7frt', 'key')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('a')).toBe('fix the cart')
    input.note('old', 'key')
    input.note('\x15', 'key')
    input.note('\x1b[200~line one\rline two\x1b[201~', 'paste')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('b')).toBe('line one\nline two')
  })

  it('does not let a foreign Enter submit text the human typed', () => {
    const { input } = pane()
    input.note('always skip the tests', 'key')
    input.note('\r', null)
    expect(input.claimHumanPrompt('x')).toBeNull()
  })

  it('hands over nothing for an Enter that carried no text, such as a menu choice', () => {
    const { input } = pane()
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).toBeNull()
  })

  it('hands over nothing when the line was edited with the cursor, because the text is then unknown', () => {
    const { input } = pane()
    input.note('fix the cart', 'key')
    input.note('\x1b[D', 'key')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('x')).toBeNull()
    input.note('fix\x17', 'key')
    input.note('\r', 'key')
    expect(input.claimHumanPrompt('y')).toBeNull()
  })

  it('has no prompt before anything was submitted', () => {
    expect(pane().input.claimHumanPrompt('x')).toBeNull()
  })
})

describe('humanInputSource', () => {
  it('accepts only the two sources the renderer names', () => {
    expect(humanInputSource('key')).toBe('key')
    expect(humanInputSource('paste')).toBe('paste')
    expect(humanInputSource('ostia')).toBeNull()
    expect(humanInputSource(undefined)).toBeNull()
    expect(humanInputSource({ toString: () => 'key' })).toBeNull()
  })
})
