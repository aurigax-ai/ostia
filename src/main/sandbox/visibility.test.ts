import { describe, expect, it } from 'vitest'
import { sandboxEntries, sandboxPath, visibleInSandbox } from './visibility'

const rules = {
  denyRead: ['/home/u', '/home/u/app/.pine/vault.json'],
  allowRead: ['/home/u/app', '/home/u/.zshrc', '/home/u/.cargo', '/home/u/.config/vivid'],
}

describe('visibleInSandbox', () => {
  it('hides what is read-denied unless a deeper allowed path covers it', () => {
    expect(visibleInSandbox('/usr/bin', rules)).toBe(true)
    expect(visibleInSandbox('/home/u/.ssh/id_ed25519', rules)).toBe(false)
    expect(visibleInSandbox('/home/u/app/src/a.ts', rules)).toBe(true)
    expect(visibleInSandbox('/home/u/app/.pine/vault.json', rules)).toBe(false)
    expect(visibleInSandbox('/home/u/application', rules)).toBe(false)
  })
})

describe('sandboxPath', () => {
  it('keeps only the PATH folders the sandboxed shell can read', () => {
    expect(
      sandboxPath('/usr/bin:/home/u/.local/share/pnpm:/home/u/.cargo/bin::/home/u/.bun/bin', rules),
    ).toBe('/usr/bin:/home/u/.cargo/bin')
  })
})

describe('sandboxEntries', () => {
  const entry = (name: string) => ({ name, dir: true })

  it('lists a hidden folder as the sandbox shows it: only what is allowed or leads to it', () => {
    const home = ['.ssh', '.zshrc', '.cargo', '.config', 'app', 'Documents'].map(entry)
    expect(sandboxEntries('/home/u', home, rules).map((e) => e.name)).toEqual([
      '.zshrc',
      '.cargo',
      '.config',
      'app',
    ])
    expect(
      sandboxEntries('/home/u/.config', ['gh', 'vivid'].map(entry), rules).map((e) => e.name),
    ).toEqual(['vivid'])
  })

  it('leaves a folder outside every denied path as it is', () => {
    const etc = ['hosts', 'passwd'].map(entry)
    expect(sandboxEntries('/etc', etc, rules)).toEqual(etc)
  })
})
