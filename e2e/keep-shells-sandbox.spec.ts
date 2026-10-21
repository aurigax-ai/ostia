import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { holdPort } from '../test/heldPort'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { PROMPT, openWorkspace, quitApp, restartApp, runInTerminal } from './helpers'
import { sandboxedShell } from './sandboxShell'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

test.skip(process.platform !== 'linux', 'sandboxed kept shells are exercised on Linux')

interface Launched {
  app: ElectronApplication
  win: Page
}

let dataHome: string
let home: string

async function launch(): Promise<Launched> {
  const options = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...options,
    env: { ...options.env, HOME: home },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  return { app, win }
}

function screen(win: Page) {
  return win.locator('.xterm-rows').first()
}

function card(win: Page) {
  return win.getByRole('region', { name: 'Agent permission request' })
}

test.beforeEach(() => {
  dataHome = freshDataHome()
  home = join(dataHome, 'home')
  const project = join(home, 'project')
  mkdirSync(project, { recursive: true })
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    terminal: { keepShells: true },
    workspaces: { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: project },
  })
})

test('KSH-C58 an exposed port answers again after a restart without a new approval', async () => {
  test.setTimeout(150_000)
  const held = await holdPort()
  const { port } = held
  try {
    const first = await launch()
    await openWorkspace(first.win)
    await sandboxedShell(first.win)
    await runInTerminal(first.win, `ostia sandbox expose ${port}`)
    await card(first.win).getByRole('button', { name: 'Allow for this workspace' }).click()
    await expect(screen(first.win)).toContainText(`exposed: 127.0.0.1:${port}`, { timeout: 15_000 })
    const script = `require("http").createServer((q,r)=>r.end("INSIDE-C58")).listen(${port},"127.0.0.1")`
    await runInTerminal(first.win, `ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" -e '${script}' &`)
    await expect(async () => {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('INSIDE-C58')
    }).toPass({ timeout: 30_000 })
    await restartApp(first.app, first.win)

    const second = await launch()
    try {
      await expect(screen(second.win)).toContainText(PROMPT, { timeout: 30_000 })
      await expect(async () => {
        expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('INSIDE-C58')
      }).toPass({ timeout: 30_000 })
      await expect(card(second.win)).toHaveCount(0)
    } finally {
      await quitApp(second.app)
    }
  } finally {
    held.release()
  }
})
