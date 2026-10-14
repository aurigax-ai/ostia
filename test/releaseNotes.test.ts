import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { previousTag, releaseNotes } from '../scripts/releaseNotes.mjs'

let repo: string

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: repo,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Ostia CI',
      GIT_AUTHOR_EMAIL: 'ci@ostia.invalid',
      GIT_COMMITTER_NAME: 'Ostia CI',
      GIT_COMMITTER_EMAIL: 'ci@ostia.invalid',
    },
  })
}

function commit(subject: string, tag?: string): void {
  git('commit', '--allow-empty', '-q', '-m', subject)
  if (tag) git('tag', '-a', tag, '-m', tag)
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'release-notes-'))
  git('init', '-q', '-b', 'main')
  commit('feat: first feature')
  commit('chore(release): v1.0.0', 'v1.0.0')
  commit('fix: a bug after 1.0')
  commit('chore(release): v1.1.0-rc.1', 'v1.1.0-rc.1')
  commit('feat: built on main', 'v1.1.0-main.1')
  commit('fix: found in the rc')
  commit('chore(release): v1.1.0-rc.2', 'v1.1.0-rc.2')
  commit('chore(release): v1.1.0', 'v1.1.0')
})

afterAll(() => rmSync(repo, { recursive: true, force: true }))

describe('releaseNotes', () => {
  it('lists every commit since the previous stable tag for a stable release, past its release candidates', () => {
    expect(previousTag('v1.1.0', repo)).toBe('v1.0.0')
    const notes = releaseNotes('v1.1.0', repo)
    expect(
      notes
        .split('\n')
        .filter(Boolean)
        .map((line) => line.replace(/ \(\w+\)$/, '')),
    ).toEqual(['- fix: found in the rc', '- feat: built on main', '- fix: a bug after 1.0'])
  })

  it('lists the commits since the previous release candidate for an rc, never since a main build', () => {
    expect(previousTag('v1.1.0-rc.2', repo)).toBe('v1.1.0-rc.1')
    const notes = releaseNotes('v1.1.0-rc.2', repo)
    expect(notes).toContain('- fix: found in the rc')
    expect(notes).toContain('- feat: built on main')
    expect(notes).not.toContain('a bug after 1.0')
  })

  it('lists the commits since the previous stable tag for the first rc', () => {
    expect(previousTag('v1.1.0-rc.1', repo)).toBe('v1.0.0')
    expect(releaseNotes('v1.1.0-rc.1', repo)).toMatch(/^- fix: a bug after 1\.0 \(\w+\)\n$/)
  })

  it('lists everything up to the first tag and leaves out release bumps', () => {
    expect(previousTag('v1.0.0', repo)).toBeNull()
    expect(releaseNotes('v1.0.0', repo)).toMatch(/^- feat: first feature \(\w+\)\n$/)
  })
})
