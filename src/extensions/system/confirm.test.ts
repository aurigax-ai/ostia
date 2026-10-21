import { createTranslator } from '@aurigax-ai/ostia-extension-sdk'
import { describe, expect, it } from 'vitest'
import { installConfirm } from './confirm'

const t = createTranslator(__dirname)('en')

const plan = (manager: 'pacman' | 'yay' | 'paru') => ({
  manager,
  packages: ['jq'],
  argv: [manager, '-S', 'jq'],
  command: `${manager} -S jq`,
  reason: 'need jq',
})

describe('installConfirm', () => {
  it('SBX-C89 warns that AUR helpers build and run code on this computer', () => {
    for (const manager of ['yay', 'paru'] as const) {
      expect(installConfirm(plan(manager), t).detail).toContain('AUR')
    }
    expect(installConfirm(plan('pacman'), t).detail).not.toContain('AUR')
    expect(installConfirm(plan('yay'), t).hostTerminal).toEqual(['yay', '-S', 'jq'])
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
      t,
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
