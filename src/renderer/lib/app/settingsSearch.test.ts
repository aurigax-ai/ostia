import { afterEach, describe, expect, it } from 'vitest'
import { firstMatchControl, highlightParts, matchesQuery } from './settingsSearch'

describe('matchesQuery', () => {
  it('matches any of the texts, ignoring case and surrounding spaces', () => {
    expect(matchesQuery(['Cursor style', 'Blink the cursor'], '  BLINK ')).toBe(true)
    expect(matchesQuery(['Cursor style'], 'font')).toBe(false)
  })

  it('never matches an empty query or a missing text', () => {
    expect(matchesQuery(['Cursor style'], '   ')).toBe(false)
    expect(matchesQuery([undefined, null, ''], 'a')).toBe(false)
  })

  it('treats regular expression characters in the query as plain text', () => {
    expect(matchesQuery(['Lines (max)'], '(max)')).toBe(true)
    expect(matchesQuery(['Lines max'], '(max)')).toBe(false)
    expect(matchesQuery(['anything'], '.*')).toBe(false)
    expect(matchesQuery(['a.*b'], '.*')).toBe(true)
  })

  it('matches text in another script', () => {
    expect(matchesQuery(['游標樣式'], '游標')).toBe(true)
  })
})

describe('highlightParts', () => {
  it('splits every occurrence out as a match, keeping the original case', () => {
    expect(highlightParts('Font and font size', 'FONT')).toEqual([
      { text: 'Font', at: 0, match: true },
      { text: ' and ', at: 4, match: false },
      { text: 'font', at: 9, match: true },
      { text: ' size', at: 13, match: false },
    ])
  })

  it('returns the whole text unmarked when nothing matches or the query is empty', () => {
    expect(highlightParts('Zoom', 'font')).toEqual([{ text: 'Zoom', at: 0, match: false }])
    expect(highlightParts('Zoom', '')).toEqual([{ text: 'Zoom', at: 0, match: false }])
    expect(highlightParts('', 'font')).toEqual([])
  })

  it('escapes the query instead of running it as a pattern', () => {
    expect(highlightParts('a+b and ab', 'a+b')).toEqual([
      { text: 'a+b', at: 0, match: true },
      { text: ' and ab', at: 3, match: false },
    ])
  })
})

describe('firstMatchControl', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns the first control of the first visible matching row', () => {
    document.body.innerHTML = `
      <div hidden><div data-search-hit><button id="hidden">x</button></div></div>
      <div data-search-hit><span>label only</span></div>
      <div><button id="plain">not a hit</button></div>
      <div data-search-hit><button disabled>off</button><input id="first" /></div>
    `
    expect(firstMatchControl(document.body)?.id).toBe('first')
  })

  it('returns null without a visible matching control', () => {
    document.body.innerHTML = '<div hidden data-search-hit><button>x</button></div>'
    expect(firstMatchControl(document.body)).toBeNull()
    expect(firstMatchControl(null)).toBeNull()
  })
})

describe('highlightParts after matchesQuery', () => {
  it('marks every match when the same query was just tested', () => {
    expect(matchesQuery(['Cursor blink'], 'blink')).toBe(true)
    expect(highlightParts('Cursor blink', 'blink')).toEqual([
      { text: 'Cursor ', at: 0, match: false },
      { text: 'blink', at: 7, match: true },
    ])
  })
})
