import { describe, expect, it } from 'vitest'
import { decodeCommandLine } from './commandLine'

describe('decodeCommandLine', () => {
  it('restores backslashes, semicolons and newlines the shell integration encoded', () => {
    expect(decodeCommandLine(String.raw`echo a\\b\x3b ls\x0acat`)).toBe('echo a\\b; ls\ncat')
  })

  it('leaves text without escapes unchanged', () => {
    expect(decodeCommandLine('git status --short')).toBe('git status --short')
  })

  it('keeps a lone backslash that is not a known escape', () => {
    expect(decodeCommandLine(String.raw`printf \n`)).toBe(String.raw`printf \n`)
  })
})
