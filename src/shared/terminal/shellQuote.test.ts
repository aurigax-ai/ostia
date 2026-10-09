import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { quoteArg, quoteArgv } from './shellQuote'

function shellWords(line: string): string[] {
  const out = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${line}`])
  return out.toString().split('\0').slice(0, -1)
}

describe('quoteArgv', () => {
  it('leaves plain words bare so the command reads naturally', () => {
    expect(quoteArgv(['sudo', 'pacman', '-S', '--needed', 'ripgrep', 'libfoo-dev:amd64'])).toBe(
      'sudo pacman -S --needed ripgrep libfoo-dev:amd64',
    )
  })

  it('single-quotes anything with shell syntax, including a leading =', () => {
    expect(quoteArg('a b')).toBe("'a b'")
    expect(quoteArg('$(rm -rf ~)')).toBe("'$(rm -rf ~)'")
    expect(quoteArg('=ls')).toBe("'=ls'")
    expect(quoteArg('')).toBe("''")
    expect(quoteArg("it's")).toBe("'it'\\''s'")
  })

  it('round-trips hostile arguments through a real shell unchanged', () => {
    const argv = ['echo', "it's", '$HOME', '`id`', 'a;b', '*', '~', 'x|y', '"q"', '\\n', '']
    expect(shellWords(quoteArgv(argv))).toEqual(argv)
  })
})
