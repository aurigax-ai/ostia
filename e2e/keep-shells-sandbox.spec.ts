import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { KEPT_SHELLS_DIR } from '../src/shared/terminal/keepShells'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import {
  PROMPT,
  newTerminalWorkspace,
  openWorkspace,
  quitApp,
  restartApp,
  runInTerminal,
} from './helpers'
import { freePort, sandboxedShell } from './sandboxShell'
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
  const port = await freePort()
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
})

test('KSH-C61 no socket a sandboxed shell can see is its sandbox host', async () => {
  test.setTimeout(90_000)
  const first = await launch()
  try {
    await openWorkspace(first.win)
    await sandboxedShell(first.win)
    const tmuxDir = join(dataHome, 'userData', KEPT_SHELLS_DIR)
    const name = createHash('sha256').update(join(dataHome, 'userData')).digest('hex').slice(0, 16)
    await runInTerminal(
      first.win,
      `echo "host-in-tmp=$(find "$TMPDIR" -type s -name '*host*' 2>/dev/null | wc -l)"; ls ${tmuxDir} 2>/dev/null | grep -c -e ${name} -e '^host-' | sed 's/^/host-seen=/'`,
    )
    await expect(screen(first.win)).toContainText('host-in-tmp=0', { timeout: 15_000 })
    await expect(screen(first.win)).toContainText('host-seen=0')
  } finally {
    await quitApp(first.app)
  }
})

test('KSH-C83 a sandboxed shell opened before keep shells was turned on cannot reach the tmux socket', async () => {
  test.setTimeout(120_000)
  const workspaces = { ...DOM_RENDERER_SETTINGS.workspaces, defaultFolder: join(home, 'project') }
  seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, workspaces })
  const { app, win } = await launch()
  try {
    await openWorkspace(win)
    await sandboxedShell(win)
    const tmuxDir = join(dataHome, 'userData', KEPT_SHELLS_DIR)
    const name = createHash('sha256').update(join(dataHome, 'userData')).digest('hex').slice(0, 16)
    const socket = join(tmuxDir, name)
    expect(existsSync(tmuxDir)).toBe(false)

    seedSettings(dataHome, { ...DOM_RENDERER_SETTINGS, terminal: { keepShells: true }, workspaces })
    await newTerminalWorkspace(win)
    await expect.poll(() => existsSync(socket), { timeout: 30_000 }).toBe(true)

    await win.locator('.deck-rail .rail-tab-main').first().click()
    const shown = win.locator('.pane-slot:not([data-hidden])')
    await shown.locator('.xterm').first().click()
    await win.keyboard.type(
      `clear; echo "sock=$([ -S ${socket} ] && echo visible || echo hidden) entries=$(ls ${tmuxDir} 2>/dev/null | wc -l | tr -d ' ') sandbox=\${HTTPS_PROXY:+on}"`,
    )
    await win.keyboard.press('Enter')
    await expect(shown.locator('.xterm-rows').first()).toContainText(
      'sock=hidden entries=0 sandbox=on',
      { timeout: 15_000 },
    )
  } finally {
    await quitApp(app)
  }
})
