import { describe, expect, it } from 'vitest'
import { installConfirm } from './confirm'
import { stringsFor } from './strings'

const plan = (manager: 'pacman' | 'yay' | 'paru') => ({
  manager,
  packages: ['jq'],
  argv: [manager, '-S', 'jq'],
  command: `${manager} -S jq`,
  reason: 'need jq',
})

describe('installConfirm', () => {
  it('SBX-C89 warns that AUR helpers build and run code on this computer', () => {
    const s = stringsFor('en')
    for (const manager of ['yay', 'paru'] as const) {
      expect(installConfirm(plan(manager), s).detail).toContain('AUR')
    }
    expect(installConfirm(plan('pacman'), s).detail).not.toContain('AUR')
    expect(installConfirm(plan('yay'), s).hostTerminal).toEqual(['yay', '-S', 'jq'])
  })
})
