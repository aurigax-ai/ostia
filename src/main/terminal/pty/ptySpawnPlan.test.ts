import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
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

const { removePane } = await import('../../control/idRegistry')
const { removeWorkspace, setWorkspaceWorkDir } = await import('../../workspaces/workspaceRegistry')
const { createSpawnPlanner } = await import('./ptySpawnPlan')

const dirs: string[] = []

function planEnv(sandboxed: boolean, sandboxWorkDir?: string) {
  return createSpawnPlanner({
    scratchFolders: { historyFile: () => null } as never,
    artifactFolders: { ensure: () => '' } as never,
    hostPaneGrants: { consume: () => false } as never,
    workspaceSandboxes: { isEnabled: () => sandboxed, workDir: () => sandboxWorkDir } as never,
    readSettingsFile: () => ({}),
    paneLauncherDir: () => '',
    keepShellsOn: () => false,
    keptShellsProgram: () => null,
    telemetry: () => null,
    bannerText: () => en.native.paneBanner,
  })
    .planSpawn('p-wsdir', { cwd: '/', workspaceId: 'w-wsdir', cols: 80, rows: 24 }, '1')
    .then((result) => (result as { env: Record<string, string> }).env)
}

afterEach(() => {
  removePane('p-wsdir')
  removeWorkspace('w-wsdir')
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('the workspace folder of a pane', () => {
  it('is the workspace folder, with the home folder expanded', async () => {
    setWorkspaceWorkDir('w-wsdir', '~/project')
    expect((await planEnv(false)).OSTIA_WORKSPACE_DIR).toBe(join(homedir(), 'project'))
  })

  it('is left out when the workspace has no absolute folder', async () => {
    setWorkspaceWorkDir('w-wsdir', 'relative/project')
    expect((await planEnv(false)).OSTIA_WORKSPACE_DIR).toBeUndefined()
  })

  it('is the real path of the sandbox folder in a sandboxed pane', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ostia-wsdir-'))
    dirs.push(root)
    const real = join(root, 'real')
    mkdirSync(real)
    symlinkSync(real, join(root, 'link'))
    setWorkspaceWorkDir('w-wsdir', '/elsewhere')
    expect((await planEnv(true, join(root, 'link'))).OSTIA_WORKSPACE_DIR).toBe(real)
  })
})
