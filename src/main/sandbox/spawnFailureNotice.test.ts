import { describe, expect, it } from 'vitest'
import { en, zhHant } from '../../shared/app/dict'
import { reportSandboxSpawnFailure } from './spawnFailureNotice'

describe('reportSandboxSpawnFailure', () => {
  it('SBX-C99 notifies with the missing package and opens the install prompt when clicked', () => {
    const posted: { title: string; body?: string; click: () => void }[] = []
    const opened: unknown[] = []
    reportSandboxSpawnFailure(
      {
        text: () => en.native.sandboxSoftware,
        notify: (input, click) => posted.push({ ...input, click }),
        showRequirements: (workspaceId, report) => opened.push({ workspaceId, report }),
        report: () => ({
          missing: [{ program: 'bwrap', package: 'bubblewrap' }],
          hint: { command: 'sudo pacman -S --needed bubblewrap', packages: ['bubblewrap'] },
          canInstall: true,
        }),
      },
      'ws',
      ['bubblewrap (bwrap) not installed'],
    )
    expect(posted).toHaveLength(1)
    expect(`${posted[0].title} ${posted[0].body}`).toContain('bubblewrap')
    posted[0].click()
    expect(opened).toEqual([
      { workspaceId: 'ws', report: expect.objectContaining({ canInstall: true }) },
    ])
  })

  it('writes the notice in the language the app shows', () => {
    const posted: { title: string; body?: string }[] = []
    reportSandboxSpawnFailure(
      {
        text: () => zhHant.native.sandboxSoftware,
        notify: (input) => posted.push(input),
        showRequirements: () => undefined,
        report: () => ({ missing: [], hint: { command: null, packages: [] }, canInstall: false }),
      },
      'ws',
      ['bubblewrap (bwrap) not installed'],
    )
    expect(posted).toEqual([
      {
        title: zhHant.native.sandboxSoftware.title,
        body: zhHant.native.sandboxSoftware.body.replace('{packages}', 'bubblewrap'),
      },
    ])
  })

  it('stays quiet when the failure is not a missing package', () => {
    const posted: unknown[] = []
    reportSandboxSpawnFailure(
      {
        text: () => en.native.sandboxSoftware,
        notify: (input) => posted.push(input),
        showRequirements: () => undefined,
        report: () => ({ missing: [], hint: { command: null, packages: [] }, canInstall: false }),
      },
      'ws',
      [],
    )
    expect(posted).toHaveLength(0)
  })
})
