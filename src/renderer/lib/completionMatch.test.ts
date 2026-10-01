import { describe, expect, it } from 'vitest'
import {
  type CompletionOrigin,
  filterCompletions,
  followDraft,
  keepSelection,
  markRuns,
  matchName,
  tabStep,
} from './completionMatch'
import { applyCompletionItem } from './inputEditor'

const folder = (name: string) => ({ name, dir: true })
const file = (name: string) => ({ name, dir: false })
const names = (matches: { item: { name: string } }[]) => matches.map((m) => m.item.name)

const avail = [folder('avail'), folder('avail-mock-feat'), folder('avail-mock-qa')]

describe('matchName', () => {
  it('ranks exact-case prefix, then any-case prefix, then substring, then subsequence', () => {
    expect(matchName('Makefile', 'Ma')).toEqual({ tier: 'prefix', marks: [0, 1] })
    expect(matchName('Makefile', 'ma')).toEqual({ tier: 'prefixIgnoreCase', marks: [0, 1] })
    expect(matchName('Makefile', 'FIL')).toEqual({ tier: 'substring', marks: [4, 5, 6] })
    expect(matchName('avail-mock-qa', 'avail-mq')).toEqual({
      tier: 'fuzzy',
      marks: [0, 1, 2, 3, 4, 5, 6, 11],
    })
    expect(matchName('avail-mock-feat', 'avail-mq')).toBeNull()
  })

  it('matches everything with an empty base and marks nothing', () => {
    expect(matchName('src', '')).toEqual({ tier: 'prefix', marks: [] })
  })
})

describe('filterCompletions', () => {
  it('orders by tier and keeps the pool order within a tier', () => {
    const pool = [file('xsrc'), file('Src'), file('sources'), file('src'), file('sorc')]
    expect(names(filterCompletions(pool, 'src'))).toEqual(['src', 'Src', 'xsrc', 'sources', 'sorc'])
  })

  it('hides dotfiles unless the base starts with a dot', () => {
    const pool = [folder('.git'), folder('src')]
    expect(names(filterCompletions(pool, ''))).toEqual(['src'])
    expect(names(filterCompletions(pool, '.g'))).toEqual(['.git'])
  })

  it('narrows the user’s folders as they type and widens again on delete', () => {
    expect(names(filterCompletions(avail, 'avail'))).toEqual([
      'avail',
      'avail-mock-feat',
      'avail-mock-qa',
    ])
    expect(names(filterCompletions(avail, 'avail-m'))).toEqual(['avail-mock-feat', 'avail-mock-qa'])
    expect(names(filterCompletions(avail, 'avail-mq'))).toEqual(['avail-mock-qa'])
    expect(names(filterCompletions(avail, 'avail-mqz'))).toEqual([])
    expect(names(filterCompletions(avail, 'av'))).toHaveLength(3)
  })
})

describe('tabStep', () => {
  const entries = [folder('src'), folder('scripts'), file('README.md'), file('my file.txt')]

  it('picks the only prefix match, ignoring case when nothing matches exactly', () => {
    expect(tabStep(entries, 'sr')).toEqual({ kind: 'pick', item: folder('src') })
    expect(tabStep(entries, 'readme')).toEqual({ kind: 'pick', item: file('README.md') })
  })

  it('picks a lone fuzzy match', () => {
    expect(tabStep(avail, 'mqa')).toEqual({ kind: 'pick', item: folder('avail-mock-qa') })
  })

  it('extends to the common prefix and lists the matches of the extended word', () => {
    const step = tabStep(avail, 'av')
    expect(step.kind).toBe('menu')
    if (step.kind !== 'menu') return
    expect(step.extend).toBe('ail')
    expect(names(step.matches)).toEqual(['avail', 'avail-mock-feat', 'avail-mock-qa'])
  })

  it('opens a menu without extending when the prefix matches share nothing more', () => {
    const step = tabStep(entries, 's')
    expect(step.kind === 'menu' && step.extend).toBe('')
    expect(step.kind === 'menu' && names(step.matches).slice(0, 2)).toEqual(['src', 'scripts'])
  })

  it('reports nothing when no name matches', () => {
    expect(tabStep(entries, 'zzz')).toEqual({ kind: 'none' })
  })
})

describe('followDraft', () => {
  const origin: CompletionOrigin = { start: 3, scope: '', pool: avail }
  const at = (text: string, caret = text.length) => followDraft(origin, text, caret)

  it('re-filters the same candidates while the word grows or shrinks', () => {
    const step = at('cd avail-m')
    expect(step.kind === 'filter' && names(step.matches)).toEqual([
      'avail-mock-feat',
      'avail-mock-qa',
    ])
    const narrower = at('cd avail-mq')
    expect(narrower.kind === 'filter' && names(narrower.matches)).toEqual(['avail-mock-qa'])
    const empty = at('cd avail-mqz')
    expect(empty.kind === 'filter' && empty.matches).toEqual([])
    const wider = at('cd av')
    expect(wider.kind === 'filter' && names(wider.matches)).toHaveLength(3)
  })

  it('asks to re-list when a slash moves the word into another directory', () => {
    expect(at('cd avail/')).toEqual({ kind: 'relist', scope: 'avail/' })
    const picked = applyCompletionItem('cd avail', 8, folder('avail'))
    expect(followDraft(origin, picked.text, picked.caret)).toEqual({
      kind: 'relist',
      scope: 'avail/',
    })
  })

  it('closes when the word ends or the caret leaves it', () => {
    expect(at('cd avail ')).toEqual({ kind: 'close' })
    expect(at('cd avail', 3)).toEqual({ kind: 'close' })
    expect(at('cd avail', 1)).toEqual({ kind: 'close' })
    expect(at('c')).toEqual({ kind: 'close' })
  })

  it('stays open on an emptied word', () => {
    const step = at('cd ')
    expect(step.kind === 'filter' && names(step.matches)).toHaveLength(3)
  })
})

describe('keepSelection', () => {
  it('follows the selected item to its new row, else returns to the first', () => {
    const before = filterCompletions(avail, 'avail')
    const after = filterCompletions(avail, 'avail-m')
    expect(keepSelection(before, 2, after)).toBe(1)
    expect(keepSelection(before, 0, after)).toBe(0)
  })
})

describe('markRuns', () => {
  it('groups marked and unmarked characters into runs that rebuild the label', () => {
    const runs = markRuns('avail-mock-qa/', [0, 1, 11])
    expect(runs).toEqual([
      { at: 0, text: 'av', marked: true },
      { at: 2, text: 'ail-mock-', marked: false },
      { at: 11, text: 'q', marked: true },
      { at: 12, text: 'a/', marked: false },
    ])
    expect(runs.map((r) => r.text).join('')).toBe('avail-mock-qa/')
  })
})
