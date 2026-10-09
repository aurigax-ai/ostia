import { describe, expect, it } from 'vitest'
import { FlagError } from '../common/args'
import { gitRequest, portsRequest } from './coreBoards'

describe('gitRequest', () => {
  it('maps the read verbs to their socket methods', () => {
    expect(gitRequest(['status'])).toEqual({ method: 'git.status', params: {} })
    expect(gitRequest(['changes'])).toEqual({ method: 'git.changes', params: {} })
    expect(gitRequest(['diff', 'a.txt', '--staged'])).toEqual({
      method: 'git.diff',
      params: { path: 'a.txt', staged: true },
    })
    expect(gitRequest(['open', 'a.txt'])).toEqual({
      method: 'git.open',
      params: { path: 'a.txt', staged: false },
    })
  })

  it('asks for text unless --json is given, and passes the limit as a number', () => {
    expect(gitRequest(['log'])).toEqual({
      method: 'git.log',
      params: { limit: undefined, text: true },
    })
    expect(gitRequest(['log', '--limit', '5', '--json'])).toEqual({
      method: 'git.log',
      params: { limit: 5, text: false },
    })
    expect(gitRequest(['blame', 'a.txt', '--json'])).toEqual({
      method: 'git.blame',
      params: { path: 'a.txt', text: false },
    })
  })

  it('sends paths as given, a dash-led path after --, and --all as a flag', () => {
    expect(gitRequest(['stage', 'a.txt', 'sub/b.txt'])).toEqual({
      method: 'git.stage',
      params: { paths: ['a.txt', 'sub/b.txt'], all: false },
    })
    expect(gitRequest(['unstage', '--all'])).toEqual({
      method: 'git.unstage',
      params: { paths: [], all: true },
    })
    expect(gitRequest(['stage', '--', '-odd.txt'])).toEqual({
      method: 'git.stage',
      params: { paths: ['-odd.txt'], all: false },
    })
  })

  it('joins repeated -m into paragraphs', () => {
    expect(gitRequest(['commit', '-m', 'subject', '--message', 'body'])).toEqual({
      method: 'git.commit',
      params: { message: 'subject\n\nbody' },
    })
  })

  it('has no discard verb and refuses unknown flags', () => {
    expect(gitRequest(['discard', 'a.txt'])).toBeNull()
    expect(gitRequest([])).toBeNull()
    expect(gitRequest(['status', 'extra'])).toBeNull()
    expect(() => gitRequest(['diff', 'a.txt', '--force'])).toThrow(FlagError)
  })
})

describe('portsRequest', () => {
  it('lists the caller workspace, or every workspace with --all', () => {
    expect(portsRequest(['ls'])).toEqual({ method: 'ports.ls', params: { all: false } })
    expect(portsRequest(['ls', '--all'])).toEqual({ method: 'ports.ls', params: { all: true } })
    expect(portsRequest(['open', '3000'])).toBeNull()
    expect(portsRequest([])).toBeNull()
  })
})
