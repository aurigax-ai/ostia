import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearFind, createFinder, findRanges } from './find'
import { entryForFragment, outlineOf, slugOf } from './outline'

function pageWith(html: string): HTMLElement {
  const { window } = new JSDOM(`<body><article>${html}</article></body>`)
  window.Element.prototype.scrollIntoView = () => {}
  return window.document.querySelector('article') as HTMLElement
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('findRanges', () => {
  it('finds every match in every text node, ignoring case unless asked', () => {
    const root = pageWith('<h1>Needle</h1><p>a needle and a NEEDLE</p>')
    expect(findRanges(root, 'needle', false).map((r) => r.toString())).toEqual([
      'Needle',
      'needle',
      'NEEDLE',
    ])
    expect(findRanges(root, 'needle', true).map((r) => r.toString())).toEqual(['needle'])
  })

  it('finds nothing for an empty query, does not overlap, and takes the query literally', () => {
    expect(findRanges(pageWith('<p>text</p>'), '', false)).toEqual([])
    expect(findRanges(pageWith('<p>aaaa</p>'), 'aa', false)).toHaveLength(2)
    expect(findRanges(pageWith('<p>a.c abc</p>'), 'a.c', false)).toHaveLength(1)
  })
})

describe('createFinder', () => {
  function stubHighlights(): Map<string, { size: number }> {
    const highlights = new Map<string, { size: number }>()
    vi.stubGlobal('CSS', { highlights })
    vi.stubGlobal(
      'Highlight',
      class {
        size: number
        constructor(...ranges: Range[]) {
          this.size = ranges.length
        }
      },
    )
    return highlights
  }

  it('counts matches, steps through them with wrap-around and paints them', () => {
    const highlights = stubHighlights()
    const root = pageWith('<h1>Needle</h1><p>One needle, then another needle.</p>')
    const reported: { index: number; total: number }[] = []
    const finder = createFinder(root, (result) => reported.push(result))
    finder.search('needle', { matchCase: false, highlightAll: true })
    expect(reported.at(-1)).toEqual({ index: 1, total: 3 })
    expect(highlights.get('ostia-find')?.size).toBe(3)
    expect(highlights.get('ostia-find-active')?.size).toBe(1)
    finder.step(1)
    expect(reported.at(-1)).toEqual({ index: 2, total: 3 })
    finder.step(-1)
    finder.step(-1)
    expect(reported.at(-1)).toEqual({ index: 3, total: 3 })
    finder.search('absent', { matchCase: false, highlightAll: true })
    expect(reported.at(-1)).toEqual({ index: 0, total: 0 })
    expect(highlights.has('ostia-find-active')).toBe(false)
    finder.search('needle', { matchCase: false, highlightAll: false })
    expect(highlights.has('ostia-find')).toBe(false)
    finder.close()
    expect(highlights.size).toBe(0)
    clearFind()
  })

  it('searches again after the text changes without losing its place', () => {
    stubHighlights()
    const root = pageWith('<p>needle one needle two</p>')
    const reported: { index: number; total: number }[] = []
    const finder = createFinder(root, (result) => reported.push(result))
    finder.search('needle', { matchCase: false, highlightAll: false })
    finder.step(1)
    root.innerHTML = '<p>needle</p>'
    finder.refresh()
    expect(reported.at(-1)).toEqual({ index: 1, total: 1 })
  })
})

describe('outline', () => {
  it('lists headings with their level and GitHub-style slugs, numbering repeats', () => {
    const root = pageWith('<h1>Run it</h1><h2>Run it</h2><h3>Étape 1: Go!</h3><p>x</p>')
    const entries = outlineOf(root)
    expect(entries.map((e) => [e.level, e.text, e.slug])).toEqual([
      [1, 'Run it', 'run-it'],
      [2, 'Run it', 'run-it-1'],
      [3, 'Étape 1: Go!', 'étape-1-go'],
    ])
    expect(entryForFragment(entries, 'run-it-1')?.level).toBe(2)
    expect(entryForFragment(entries, '%C3%89tape-1-go')?.level).toBe(3)
    expect(entryForFragment(entries, 'missing')).toBeNull()
    expect(slugOf('  A  B ')).toBe('a--b')
  })
})
