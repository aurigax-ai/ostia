import { freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { type ElectronApplication, type Page, _electron as electron } from './test'

export const GHOSTTY = {
  behavior: { gpuAcceleration: false },
  terminal: { renderer: 'ghostty' },
  workspaces: { confirmQuit: false },
}

export const BENCH_ENGINES = [
  { name: 'xterm-dom', settings: { behavior: { gpuAcceleration: false } } },
  { name: 'xterm-webgl', settings: { behavior: { gpuAcceleration: true } } },
  {
    name: 'ghostty-canvas',
    settings: { behavior: { gpuAcceleration: false }, terminal: { renderer: 'ghostty' } },
  },
  {
    name: 'ghostty-gpu',
    settings: { behavior: { gpuAcceleration: true }, terminal: { renderer: 'ghostty' } },
  },
]

export async function launchGhostty(
  settings: Record<string, unknown> = {},
  args: string[] = [],
): Promise<{ app: ElectronApplication; win: Page }> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...GHOSTTY, ...settings })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    args: [...args, ...launch.args],
    env: { ...launch.env, SHELL: '/bin/zsh' },
  })
  const win = await app.firstWindow()
  await openWorkspace(win)
  await win.locator('.ghostty-screen').first().click()
  return { app, win }
}
