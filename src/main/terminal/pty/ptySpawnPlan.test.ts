import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
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
const { shellIntegrationDir } = await import('../shellIntegration')
const { privateTmpDir } = await import('../../platform/privateTmp')

const dirs: string[] = []

function planner(sandboxed: boolean, sandboxWorkDir?: string) {
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
}

function plan(sandboxed: boolean, sandboxWorkDir?: string) {
  return planner(sandboxed, sandboxWorkDir)
    .planSpawn('p-wsdir', { cwd: '/', workspaceId: 'w-wsdir', cols: 80, rows: 24 }, '1')
    .then(
      (result) =>
        result as { env: Record<string, string>; args: string[]; integrationNotice: string },
    )
}

function planEnv(sandboxed: boolean, sandboxWorkDir?: string) {
  return plan(sandboxed, sandboxWorkDir).then((result) => result.env)
}

afterEach(() => {
  vi.unstubAllEnvs()
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

describe('a pane whose shell integration cannot be written', () => {
  it.skipIf(process.getuid?.() === 0)(
    'opens a plain shell and shows that the integration is not loaded',
    async () => {
      vi.stubEnv('SHELL', '/bin/bash')
      const dir = shellIntegrationDir()
      rmSync(join(dir, 'bashrc'))
      chmodSync(dirname(dir), 0o500)
      try {
        const result = await plan(false)
        expect(result.args).not.toContain('--rcfile')
        expect(result.env.OSTIA_AGENT_DIR).toBeUndefined()
        expect(result.integrationNotice).toContain('Shell integration not loaded (EACCES)')
      } finally {
        chmodSync(dirname(dir), 0o700)
      }
      expect((await plan(false)).integrationNotice).toBe('')
    },
  )
})

describe('a pane whose shell state folder cannot be written', () => {
  it.skipIf(process.getuid?.() === 0)(
    'opens a plain shell with the banner instead of failing to start',
    async () => {
      vi.stubEnv('SHELL', '/bin/bash')
      const stateDir = privateTmpDir('ostia-shell-state')
      chmodSync(stateDir, 0o500)
      try {
        const result = await plan(false)
        expect(result.args).not.toContain('--rcfile')
        expect(result.env.OSTIA_AGENT_DIR).toBeUndefined()
        expect(result.integrationNotice).toContain('Shell integration not loaded (EACCES)')
      } finally {
        chmodSync(stateDir, 0o700)
      }
      expect((await plan(false)).args).toContain('--rcfile')
    },
  )
})
