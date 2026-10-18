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

  it('ostia system install asks the human with the packages, the exact command and the reason, to Approve or Deny', () => {
    const asked = installConfirm(
      {
        manager: 'pacman',
        packages: ['ripgrep', 'fd'],
        argv: ['sudo', 'pacman', '-S', '--needed', 'ripgrep', 'fd'],
        command: 'sudo pacman -S --needed ripgrep fd',
        reason: 'e2e-check',
      },
      stringsFor('en'),
    )
    expect(asked).toMatchObject({
      title: 'Install system packages',
      confirmLabel: 'Approve',
      cancelLabel: 'Deny',
      hostTerminal: ['sudo', 'pacman', '-S', '--needed', 'ripgrep', 'fd'],
    })
    expect(asked.message).toContain('ripgrep, fd')
    expect(asked.message).toContain('pacman')
    expect(asked.detail).toContain('sudo pacman -S --needed ripgrep fd')
    expect(asked.detail).toContain('e2e-check')
  })
})
