import { describe, expect, it } from 'vitest'
import {
  branchChipText,
  branchLabel,
  diffStatsChipText,
  parsePorcelainV2,
  parseShortstat,
  summarize,
} from './status'

describe('branchChipText', () => {
  const branch = { oid: 'f'.repeat(40), head: 'main', upstream: null, ahead: 0, behind: 0 }

  it('shows the branch alone when there is no upstream or it is in sync', () => {
    expect(branchChipText(branch)).toBe('main')
    expect(branchChipText({ ...branch, ahead: 3 })).toBe('main')
    expect(branchChipText({ ...branch, upstream: 'origin/main' })).toBe('main')
  })

  it('adds ahead and behind after a bullet when tracking an upstream', () => {
    const tracked = { ...branch, upstream: 'origin/main' }
    expect(branchChipText({ ...tracked, ahead: 2, behind: 1 })).toBe('main • ↑2 ↓1')
    expect(branchChipText({ ...tracked, behind: 4 })).toBe('main • ↓4')
    expect(branchChipText({ ...tracked, ahead: 1200 })).toBe('main • ↑999+')
  })

  it('shows the short sha when detached and nothing without any commit or branch', () => {
    expect(branchChipText({ ...branch, head: null })).toBe('fffffff')
    expect(branchChipText({ ...branch, head: null, oid: null })).toBe('')
  })
})

describe('diff stats', () => {
  it('parses git diff --shortstat output', () => {
    expect(parseShortstat(' 3 files changed, 12 insertions(+), 4 deletions(-)\n')).toEqual({
      files: 3,
      added: 12,
      removed: 4,
    })
    expect(parseShortstat(' 1 file changed, 1 insertion(+)')).toEqual({
      files: 1,
      added: 1,
      removed: 0,
    })
    expect(parseShortstat(' 1 file changed, 2 deletions(-)')).toEqual({
      files: 1,
      added: 0,
      removed: 2,
    })
    expect(parseShortstat('')).toBeNull()
  })

  it('formats files • +added -removed and hides a clean tree', () => {
    expect(diffStatsChipText({ files: 3, added: 12, removed: 4 })).toBe('3 • +12 -4')
    expect(diffStatsChipText({ files: 1, added: 0, removed: 2 })).toBe('1 • -2')
    expect(diffStatsChipText({ files: 1, added: 0, removed: 0 })).toBe('1')
    expect(diffStatsChipText(null)).toBe('')
  })
})

const Z = '\0'

function porcelain(...records: string[]): string {
  return records.map((r) => `${r}${Z}`).join('')
}

const HASH = 'a'.repeat(40)
const MODES = `100644 100644 100644 ${HASH} ${HASH}`

describe('parsePorcelainV2', () => {
  it('reads branch, upstream and ahead/behind headers', () => {
    const status = parsePorcelainV2(
      porcelain(
        `# branch.oid ${HASH}`,
        '# branch.head feature/x',
        '# branch.upstream origin/feature/x',
        '# branch.ab +3 -1',
      ),
    )
    expect(status.branch).toEqual({
      oid: HASH,
      head: 'feature/x',
      upstream: 'origin/feature/x',
      ahead: 3,
      behind: 1,
    })
    expect(status.changes).toEqual([])
  })

  it('reports a fresh repo and a detached HEAD as nulls', () => {
    expect(
      parsePorcelainV2(porcelain('# branch.oid (initial)', '# branch.head main')).branch,
    ).toMatchObject({ oid: null, head: 'main', upstream: null, ahead: 0, behind: 0 })
    expect(
      parsePorcelainV2(porcelain(`# branch.oid ${HASH}`, '# branch.head (detached)')).branch,
    ).toMatchObject({ oid: HASH, head: null })
  })

  it('splits an ordinary entry into staged and unstaged changes, keeping spaces in paths', () => {
    const status = parsePorcelainV2(
      porcelain(`1 MM N... ${MODES} src/a file.ts`, `1 .D N... ${MODES} gone.txt`),
    )
    expect(status.changes).toEqual([
      { path: 'src/a file.ts', area: 'staged', code: 'M' },
      { path: 'src/a file.ts', area: 'unstaged', code: 'M' },
      { path: 'gone.txt', area: 'unstaged', code: 'D' },
    ])
  })

  it('reads a rename with its original path from the next NUL field', () => {
    const status = parsePorcelainV2(
      porcelain(`2 R. N... ${MODES} R100 new name.ts`, 'old name.ts', '? after.txt'),
    )
    expect(status.changes).toEqual([
      { path: 'new name.ts', origPath: 'old name.ts', area: 'staged', code: 'R' },
      { path: 'after.txt', area: 'untracked', code: '?' },
    ])
  })

  it('reads unmerged and untracked entries and ignores ignored ones', () => {
    const status = parsePorcelainV2(
      porcelain(
        `u UU N... 100644 100644 100644 100644 ${HASH} ${HASH} ${HASH} both.txt`,
        '? new dir/file.md',
        '! build/out.js',
      ),
    )
    expect(status.changes).toEqual([
      { path: 'both.txt', area: 'conflicted', code: 'U' },
      { path: 'new dir/file.md', area: 'untracked', code: '?' },
    ])
  })
})

describe('summarize', () => {
  it('counts new files (untracked or staged adds) apart from other changes, per path', () => {
    const status = parsePorcelainV2(
      porcelain(
        `1 A. N... ${MODES} added.ts`,
        `1 AM N... ${MODES} added-then-edited.ts`,
        `1 MM N... ${MODES} both.ts`,
        `1 .M N... ${MODES} edited.ts`,
        '? scratch.txt',
      ),
    )
    expect(summarize(status)).toEqual({
      added: 3,
      changed: 2,
      staged: 3,
      unstaged: 3,
      untracked: 1,
      conflicted: 0,
    })
  })
})

describe('branchLabel', () => {
  it('labels a detached HEAD by short sha and truncates long branch names', () => {
    expect(branchLabel({ oid: HASH, head: null, upstream: null, ahead: 0, behind: 0 })).toBe(
      '(aaaaaaa)',
    )
    const long = branchLabel({
      oid: null,
      head: 'x'.repeat(60),
      upstream: null,
      ahead: 0,
      behind: 0,
    })
    expect(long).toHaveLength(40)
    expect(long.endsWith('…')).toBe(true)
  })
})
