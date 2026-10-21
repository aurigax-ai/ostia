import type { ExecOptions, ExecResult } from '@aurigax-ai/ostia-extension-sdk'
import { describe, expect, it } from 'vitest'
import { GATHER_MAX_CHARS, gather } from './gather'

function result(stdout: string, exitCode = 0): ExecResult {
  return {
    ok: true,
    exitCode,
    timedOut: false,
    stdout,
    stderr: '',
    truncated: false,
    sandboxed: false,
  }
}

describe('handoff gather', () => {
  it('runs each source as an argv in the workspace and prints what it found', async () => {
    const seen: ExecOptions[] = []
    const text = await gather(
      async (opts) => {
        seen.push(opts)
        const [program, sub] = opts.command
        if (program === 'git' && sub === 'log') return result('abc123 fix retry\n')
        if (program === 'git' && sub === 'status') return result(' M src/a.ts\n')
        if (program === 'rg') return result('src/a.ts\nsrc/b.ts\n')
        if (program === 'gh') return result(opts.command[1] === 'pr' ? '#9 OPEN retry\n' : '')
        return result('', 1)
      },
      'w1',
      ['retry', 'checkout'],
    )
    expect(text).toContain('commits that mention it:\n  abc123 fix retry')
    expect(text).toContain('uncommitted:\n   M src/a.ts')
    expect(text).toContain('files that mention it:\n  src/a.ts\n  src/b.ts')
    expect(text).toContain('pr #9 OPEN retry')
    expect(seen.every((o) => o.workspaceId === 'w1')).toBe(true)
    expect(seen.find((o) => o.command[0] === 'git' && o.command[1] === 'log')?.command).toEqual([
      'git',
      'log',
      '--oneline',
      '-20',
      '-i',
      '--grep=retry',
      '--grep=checkout',
    ])
    expect(seen.find((o) => o.command[0] === 'rg')?.command).toEqual([
      'rg',
      '-l',
      '-i',
      '--max-count',
      '1',
      '-e',
      'retry',
      '-e',
      'checkout',
    ])
  })

  it('falls back to git grep when rg is missing and skips what cannot run', async () => {
    const programs: string[] = []
    const text = await gather(
      async (opts) => {
        programs.push(opts.command.slice(0, 2).join(' '))
        if (opts.command[0] === 'rg' || opts.command[0] === 'gh') {
          return { ok: false, error: 'spawn-failed' }
        }
        return opts.command[1] === 'grep' ? result('src/c.ts\n') : result('', 1)
      },
      'w1',
      ['retry'],
    )
    expect(programs).toContain('git grep')
    expect(text).toBe('files that mention it:\n  src/c.ts')
  })

  it('says so when nothing matches and caps the answer', async () => {
    expect(await gather(async () => result('', 1), 'w1', ['zzz'])).toBe(
      'nothing found for those words',
    )
    const long = await gather(async () => result(`${'x'.repeat(400)}\n`.repeat(30)), 'w1', [
      'retry',
    ])
    expect(long.length).toBeLessThanOrEqual(GATHER_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })
})
