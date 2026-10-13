import { describe, expect, it } from 'vitest'
import { findRanges } from './domFind'

function rootWith(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html
  return root
}

describe('findRanges', () => {
  it('finds every match in every text node, ignoring case', () => {
    const root = rootWith('<h1>Needle</h1><p>a needle and a NEEDLE</p>')
    const ranges = findRanges(root, 'needle')
    expect(ranges.map((r) => r.toString())).toEqual(['Needle', 'needle', 'NEEDLE'])
  })

  it('finds nothing for an empty query', () => {
    expect(findRanges(rootWith('<p>text</p>'), '')).toEqual([])
  })

  it('does not overlap matches', () => {
    expect(findRanges(rootWith('<p>aaaa</p>'), 'aa')).toHaveLength(2)
  })
})
