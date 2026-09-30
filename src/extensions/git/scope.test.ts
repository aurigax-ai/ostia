import { describe, expect, it } from 'vitest'
import { FIELD_SEP } from './history'
import { type BranchRef, parseBranchRefs, parseScope, planScope } from './scope'

const line = (...fields: string[]): string => fields.join(FIELD_SEP)

const branches: BranchRef[] = parseBranchRefs(
  [
    line('refs/heads/feature', 'f'.repeat(40), '300', ''),
    line('refs/remotes/origin/main', 'b'.repeat(40), '400', ''),
    line('refs/remotes/origin/HEAD', 'b'.repeat(40), '400', 'refs/remotes/origin/main'),
    line('refs/heads/main', 'a'.repeat(40), '100', ''),
    line('refs/heads/old', 'c'.repeat(40), '50', ''),
  ].join('\n'),
  'main',
)

describe('parseBranchRefs', () => {
  it('lists the current branch first, then local and remote branches by recency', () => {
    expect(branches.map((b) => b.name)).toEqual(['main', 'feature', 'old', 'origin/main'])
    expect(branches[0]).toMatchObject({ ref: 'refs/heads/main', current: true, remote: false })
    expect(branches[3]).toMatchObject({ remote: true, current: false })
  })

  it('drops symbolic refs such as origin/HEAD', () => {
    expect(branches.some((b) => b.ref === 'refs/remotes/origin/HEAD')).toBe(false)
  })
})

describe('parseScope', () => {
  it('accepts the three scope kinds', () => {
    expect(parseScope({ kind: 'current' })).toEqual({ kind: 'current' })
    expect(parseScope({ kind: 'all', refs: ['x'] })).toEqual({ kind: 'all' })
    expect(parseScope({ kind: 'chosen', refs: ['refs/heads/a', 'refs/heads/a'] })).toEqual({
      kind: 'chosen',
      refs: ['refs/heads/a'],
    })
  })

  it('refuses anything that is not a branch ref, so no option reaches git', () => {
    expect(parseScope({ kind: 'chosen', refs: ['--all', 'HEAD', 'refs/tags/v1', 7] })).toBeNull()
    expect(parseScope({ kind: 'chosen', refs: ['refs/heads/a', '--output=x'] })).toEqual({
      kind: 'chosen',
      refs: ['refs/heads/a'],
    })
    expect(parseScope({ kind: 'everything' })).toBeNull()
    expect(parseScope('all')).toBeNull()
  })
})

describe('planScope', () => {
  it('shows only the current branch by default', () => {
    expect(planScope({ kind: 'current' }, branches)).toEqual({
      scope: { kind: 'current' },
      revisions: ['HEAD'],
      includesHead: true,
    })
  })

  it('shows local and remote branches plus a detached HEAD for all', () => {
    expect(planScope({ kind: 'all' }, branches).revisions).toEqual([
      '--branches',
      '--remotes',
      'HEAD',
    ])
  })

  it('keeps only chosen branches that still exist, after --end-of-options', () => {
    const plan = planScope(
      {
        kind: 'chosen',
        refs: ['refs/heads/feature', 'refs/heads/gone', 'refs/remotes/origin/main'],
      },
      branches,
    )
    expect(plan.scope).toEqual({
      kind: 'chosen',
      refs: ['refs/heads/feature', 'refs/remotes/origin/main'],
    })
    expect(plan.revisions).toEqual([
      '--end-of-options',
      'refs/heads/feature',
      'refs/remotes/origin/main',
    ])
    expect(plan.includesHead).toBe(false)
    expect(planScope({ kind: 'chosen', refs: ['refs/heads/main'] }, branches).includesHead).toBe(
      true,
    )
  })

  it('falls back to the current branch when none of the chosen branches exist', () => {
    expect(planScope({ kind: 'chosen', refs: ['refs/heads/gone'] }, branches).scope).toEqual({
      kind: 'current',
    })
  })
})
