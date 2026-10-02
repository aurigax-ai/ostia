import { describe, expect, it } from 'vitest'
import { parseShellSetting, shellArgv, shellName } from './terminalShell'

describe('shellArgv', () => {
  it('falls back to the login shell when the setting is empty or not a string', () => {
    expect(shellArgv('', '/bin/zsh')).toEqual(['/bin/zsh'])
    expect(shellArgv('   ', '/bin/zsh')).toEqual(['/bin/zsh'])
    expect(shellArgv(42, '/bin/zsh')).toEqual(['/bin/zsh'])
    expect(shellArgv(undefined, '/bin/zsh')).toEqual(['/bin/zsh'])
  })

  it('splits the program and its arguments without a shell, keeping quoted words whole', () => {
    expect(shellArgv('/usr/bin/fish', '/bin/zsh')).toEqual(['/usr/bin/fish'])
    expect(shellArgv('nu --config "/home/me/my config.nu"', '/bin/zsh')).toEqual([
      'nu',
      '--config',
      '/home/me/my config.nu',
    ])
  })

  it('treats shell syntax as plain words', () => {
    expect(shellArgv('bash; rm -rf ~', '/bin/zsh')).toEqual(['bash;', 'rm', '-rf', '~'])
  })

  it('falls back on an unclosed quote, an empty program, a NUL byte or an oversized value', () => {
    expect(shellArgv('fish "-l', '/bin/zsh')).toEqual(['/bin/zsh'])
    expect(shellArgv('"" -l', '/bin/zsh')).toEqual(['/bin/zsh'])
    expect(shellArgv('fish\0', '/bin/zsh')).toEqual(['/bin/zsh'])
    expect(shellArgv(`fish ${'x'.repeat(2000)}`, '/bin/zsh')).toEqual(['/bin/zsh'])
  })
})

describe('parseShellSetting', () => {
  it('keeps a trimmed string and drops anything else', () => {
    expect(parseShellSetting('  /bin/fish  ')).toBe('/bin/fish')
    expect(parseShellSetting(['fish'])).toBe('')
  })
})

describe('shellName', () => {
  it('names a shell by the last part of its program path', () => {
    expect(shellName('/usr/bin/zsh')).toBe('zsh')
    expect(shellName('/bin/bash')).toBe('bash')
    expect(shellName('fish')).toBe('fish')
    expect(shellName('C:\\Windows\\System32\\powershell.exe')).toBe('powershell.exe')
  })

  it('is empty when there is no program to name', () => {
    expect(shellName('')).toBe('')
    expect(shellName('/usr/bin/')).toBe('')
  })
})
