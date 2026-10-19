import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { en } from '../../../shared/app/dict'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    getLocale: () => 'en-US',
    getAppPath: () => '/app',
    getPath: () => '/tmp',
    isPackaged: false,
  },
}))

const { getByPaneId, removePane } = await import('../../control/idRegistry')
const { codexSocketOf, forgetCodexSocket } = await import('../../agents/codexSockets')
const { createSpawnPlanner } = await import('./ptySpawnPlan')

function plan(sandboxed: boolean) {
  return createSpawnPlanner({
    scratchFolders: { historyFile: () => null } as never,
    artifactFolders: { ensure: () => '' } as never,
    hostPaneGrants: { consume: () => false } as never,
    workspaceSandboxes: { isEnabled: () => sandboxed } as never,
    readSettingsFile: () => ({}),
    paneLauncherDir: () => '',
    keepShellsOn: () => false,
    keptShellsProgram: () => null,
    telemetry: () => null,
    bannerText: () => en.native.paneBanner,
  }).planSpawn('p-codex', { cwd: '/', workspaceId: 'w1', cols: 80, rows: 24 } as never, '1')
}

afterEach(() => {
  const id = getByPaneId('p-codex')?.externalId
  if (id) forgetCodexSocket(id)
  removePane('p-codex')
})

describe('the codex app-server socket of a pane', () => {
  it('is in its own directory, not the shell state directory a sandbox may read', async () => {
    const result = (await plan(false)) as { env: Record<string, string>; stateFile: string }
    const sock = result.env.OSTIA_CODEX_SOCK
    expect(sock).toBeTruthy()
    expect(dirname(sock)).not.toBe(dirname(result.stateFile))
  })

  it('does not exist for a sandboxed pane', async () => {
    const result = (await plan(true)) as {
      env: Record<string, string>
      identity: { externalId: string }
    }
    expect(result.env.OSTIA_CODEX_SOCK).toBeUndefined()
    expect(codexSocketOf(result.identity.externalId)).toBeUndefined()
  })
})
