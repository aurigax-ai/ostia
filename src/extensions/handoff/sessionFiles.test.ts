import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSessions, projectKey, readSessionLines, sessionsByPrefix } from './sessionFiles'

describe('handoff session files', () => {
  let root: string

  const session = (project: string, id: string, body = '{}\n', age = 0): string => {
    mkdirSync(join(root, project), { recursive: true })
    const path = join(root, project, `${id}.jsonl`)
    writeFileSync(path, body)
    const time = new Date(Date.now() - age * 1000)
    utimesSync(path, time, time)
    return path
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ostia-handoff-files-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('encodes a folder the way Claude names its project folder', () => {
    expect(projectKey('/home/u/My App/.claude')).toBe('-home-u-My-App--claude')
  })

  it('lists the folder and its worktrees, newest first, and nothing else', () => {
    const base = projectKey('/home/u/app')
    session(base, 'aaaa1111', '{}\n', 30)
    session(`${base}--claude-worktrees-fix`, 'bbbb2222', '{}\n', 10)
    session(`${base}-other`, 'cccc3333')
    session(projectKey('/home/u/else'), 'dddd4444')
    const ids = listSessions(root, ['/home/u/app']).map((s) => s.id)
    expect(ids).toEqual(['bbbb2222', 'aaaa1111'])
  })

  it('lists every project when asked for all', () => {
    session(projectKey('/a'), 'aaaa1111')
    session(projectKey('/b'), 'bbbb2222')
    expect(listSessions(root, 'all')).toHaveLength(2)
  })

  it('skips links and non-regular entries when listing', () => {
    const base = projectKey('/home/u/app')
    const real = session(base, 'aaaa1111')
    symlinkSync(real, join(root, base, 'bbbb2222.jsonl'))
    mkdirSync(join(root, base, 'cccc3333.jsonl'))
    expect(listSessions(root, ['/home/u/app']).map((s) => s.id)).toEqual(['aaaa1111'])
  })

  it('finds a session by id prefix in any project and ignores odd prefixes', () => {
    session(projectKey('/a'), 'abcd1234-0000')
    expect(sessionsByPrefix(root, 'abcd')).toHaveLength(1)
    expect(sessionsByPrefix(root, 'zz')).toEqual([])
    expect(sessionsByPrefix(root, '../')).toEqual([])
  })

  it('reads whole lines and drops the cut first line of a large file', () => {
    const path = session('p', 'aaaa1111', 'one\ntwo\nthree\n')
    expect(readSessionLines(path)).toEqual(['one', 'two', 'three'])
    expect(readSessionLines(path, 8)).toEqual(['three'])
  })

  it('refuses to read through a link', () => {
    const real = session('p', 'aaaa1111')
    const link = join(root, 'p', 'link.jsonl')
    symlinkSync(real, link)
    expect(() => readSessionLines(link)).toThrow()
  })

  it('refuses a pipe', () => {
    const fifo = join(root, 'pipe.jsonl')
    execFileSync('mkfifo', [fifo])
    expect(() => readSessionLines(fifo)).toThrow('not a regular file')
  })
})
