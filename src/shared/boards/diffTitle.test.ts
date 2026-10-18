import { describe, expect, it } from 'vitest'
import { changeDiffTitle, commitDiffTitle, filesDiffTitle } from './diffTitle'

describe('diff titles', () => {
  it('names a change like VS Code by the side it shows', () => {
    expect(changeDiffTitle('notes.txt', 'unstaged', 'M')).toBe('notes.txt (Working Tree)')
    expect(changeDiffTitle('notes.txt', 'staged', 'M')).toBe('notes.txt (Index)')
    expect(changeDiffTitle('notes.txt', 'untracked', '?')).toBe('notes.txt (Untracked)')
    expect(changeDiffTitle('notes.txt', 'conflicted', 'U')).toBe('notes.txt (Working Tree)')
  })

  it('names a deleted file Deleted whichever area it is in', () => {
    expect(changeDiffTitle('gone.txt', 'staged', 'D')).toBe('gone.txt (Deleted)')
    expect(changeDiffTitle('gone.txt', 'unstaged', 'D')).toBe('gone.txt (Deleted)')
  })

  it('names a commit file by its parent and the commit', () => {
    expect(commitDiffTitle('a.ts', 'abcdef0123456789')).toBe('a.ts (abcdef0^) ↔ a.ts (abcdef0)')
  })

  it('names two files with an arrow', () => {
    expect(filesDiffTitle('a.ts', 'b.ts')).toBe('a.ts ↔ b.ts')
  })
})
