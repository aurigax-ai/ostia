import { describe, expect, it } from 'vitest'
import { crumbsOf, fitCrumbs, maxFitLevel, shortName } from './breadcrumb'

const labels = (crumbs: { label: string }[]): string[] => crumbs.map((c) => c.label)

describe('crumbsOf', () => {
  it('shows the home folder as ~', () => {
    expect(labels(crumbsOf('/home/me/Personal/terminal', '/home/me'))).toEqual([
      '~',
      'Personal',
      'terminal',
    ])
    expect(labels(crumbsOf('/home/me', '/home/me/'))).toEqual(['~'])
  })

  it('keeps a path outside home whole and a literal ~ path as it is', () => {
    expect(labels(crumbsOf('/var/log', '/home/me'))).toEqual(['var', 'log'])
    expect(labels(crumbsOf('/home/meow', '/home/me'))).toEqual(['home', 'meow'])
    expect(labels(crumbsOf('~/src', null))).toEqual(['~', 'src'])
    expect(labels(crumbsOf('/', '/home/me'))).toEqual(['/'])
  })

  it('gives every crumb a unique key', () => {
    const keys = crumbsOf('/a/a/a', null).map((c) => c.key)
    expect(new Set(keys).size).toBe(3)
  })
})

describe('shortName', () => {
  it('keeps the first letter, and the dot of a dot folder', () => {
    expect(shortName('Personal')).toBe('P')
    expect(shortName('.sdd')).toBe('.s')
    expect(shortName('文件夾')).toBe('文')
  })
})

describe('fitCrumbs', () => {
  const crumbs = crumbsOf('/home/me/Personal/terminal/.sdd/verify', '/home/me')

  it('shows full names at level 0', () => {
    expect(labels(fitCrumbs(crumbs, 0))).toEqual(['~', 'Personal', 'terminal', '.sdd', 'verify'])
  })

  it('shortens every name but the last at level 1', () => {
    expect(labels(fitCrumbs(crumbs, 1))).toEqual(['~', 'P', 't', '.s', 'verify'])
  })

  it('folds the leading crumbs into … from level 2 and keeps the last whole', () => {
    expect(labels(fitCrumbs(crumbs, 2))).toEqual(['…', 'P', 't', '.s', 'verify'])
    expect(labels(fitCrumbs(crumbs, 3))).toEqual(['…', 't', '.s', 'verify'])
    expect(labels(fitCrumbs(crumbs, maxFitLevel(crumbs)))).toEqual(['…', 'verify'])
  })
})
