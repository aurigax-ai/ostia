import { describe, expect, it } from 'vitest'
import { parseDevSource } from './devSource'

describe('parseDevSource', () => {
  it('reads an absolute path as a folder', () => {
    expect(parseDevSource(' /home/me/ext ')).toEqual({ kind: 'folder', path: '/home/me/ext' })
  })

  it('reads repo#branch and repo#branch:folder as a git branch', () => {
    expect(parseDevSource('owner/repo#fix/x')).toEqual({
      kind: 'git',
      url: 'owner/repo',
      branch: 'fix/x',
    })
    expect(parseDevSource('https://github.com/o/r.git#main:src/ext')).toEqual({
      kind: 'git',
      url: 'https://github.com/o/r.git',
      branch: 'main',
      path: 'src/ext',
    })
  })

  it('refuses text with no branch, no repository or nothing', () => {
    for (const text of ['', 'owner/repo', 'owner/repo#', '#main', 'relative/path']) {
      expect(parseDevSource(text)).toBeNull()
    }
  })
})
