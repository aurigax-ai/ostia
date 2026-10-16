import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getVersion: () => '0.0.0',
    getLocale: () => 'en-US',
    getAppPath: () => '/app',
    getPath: () => '/tmp',
    isPackaged: false,
  },
}))

const { registerPane, removePane } = await import('../../control/idRegistry')
const { createSpawnPlanner } = await import('./ptySpawnPlan')
const { createPtyAttach } = await import('./ptyAttach')

const program = { tmux: '/usr/bin/tmux', defaultTerminal: 'screen-256color', env: {} }

function planner(keepShells: boolean, found: boolean) {
  return createSpawnPlanner({
    scratchFolders: { historyFile: () => null } as never,
    artifactFolders: { ensure: () => '' } as never,
    hostPaneGrants: { consume: () => false } as never,
    workspaceSandboxes: { isEnabled: () => false } as never,
    readSettingsFile: () => ({}),
    paneLauncherDir: () => '',
    keepShellsOn: () => keepShells,
    keptShellsProgram: () => (found ? program : null),
    telemetry: () => null,
  })
}

afterEach(() => {
  removePane('p1')
  vi.unstubAllEnvs()
})

async function attach(keepShells: boolean, spawnKept: () => Promise<unknown>) {
  registerPane({ windowId: '1', workspaceId: 'w1', paneId: 'p1' })
  vi.stubEnv('TMUX', undefined)
  vi.stubEnv('OSTIA_TOKEN_FILE', '/tmp/inherited')
  const startTracked = vi.fn(() => ({ created: true }))
  const writeToken = vi.fn(() => '/tmp/tokens/p1')
  const spawned = vi.fn(spawnKept)
  const { attachPty } = createPtyAttach({
    ptys: new Map(),
    keptShells: {
      ready: Promise.resolve(),
      claim: () => null,
      takeSandboxLost: () => false,
      writeToken,
    } as never,
    loadPty: () => ({}) as never,
    subscriberFor: () => (() => ({})) as never,
    attachExisting: vi.fn() as never,
    reattachKept: vi.fn() as never,
    planSpawn: planner(keepShells, true).planSpawn,
    spawnSandboxed: vi.fn() as never,
    spawnKept: spawned as never,
    startTracked: startTracked as never,
    telemetry: () => null,
  })
  await attachPty({ sender: { id: 1 } } as never, 'p1', { cwd: '/', workspaceId: 'w1' } as never)
  const [, , , plan, keptSpawn] = startTracked.mock.calls[0] as unknown as [
    unknown,
    unknown,
    unknown,
    { env: Record<string, string>; tokenFile: string | null; notKept: string },
    { kept: unknown },
  ]
  return { plan, keptSpawn, spawned, writeToken }
}

describe('a terminal with kept shells off or unavailable', () => {
  it('KSH-C1 KSH-C81 with the setting off is a plain pty with no tmux, token file or kept spawn', async () => {
    const { plan, keptSpawn, spawned, writeToken } = await attach(false, async () => null)
    expect(spawned).not.toHaveBeenCalled()
    expect(writeToken).not.toHaveBeenCalled()
    expect(keptSpawn.kept).toBeNull()
    expect(plan.tokenFile).toBeNull()
    expect(plan.env.TMUX).toBeUndefined()
    expect(plan.env.OSTIA_TOKEN_FILE).toBeUndefined()
    expect(plan.env.OSTIA_TOKEN).toMatch(/^[0-9a-f]{64}$/)
  })

  it('KSH-C65 falls back to a plain pty with the reason when tmux cannot start its server', async () => {
    const { plan, keptSpawn, spawned } = await attach(true, async () => ({
      kept: null,
      keptMeta: null,
      notKept: 'tmux could not start its server: server refused',
    }))
    expect(spawned).toHaveBeenCalledTimes(1)
    expect(keptSpawn.kept).toBeNull()
    expect(plan.notKept).toBe('tmux could not start its server: server refused')
  })
})
