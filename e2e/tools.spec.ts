import { copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { waitForPaletteSelection } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const FIXTURES = resolve(__dirname, '../test/fixtures/tools')
const MARKETPLACE = resolve(__dirname, '../out/marketplace/extensions')

function installApproved(dataHome: string, configHome: string, ids: string[]): void {
  const records: Record<string, { enabled: boolean; approved: string[] }> = {}
  for (const id of ids) {
    const target = join(configHome, PRODUCT_NAME, 'extensions', id)
    cpSync(join(MARKETPLACE, id), target, { recursive: true })
    const manifest = JSON.parse(readFileSync(join(target, 'ostia.json'), 'utf8'))
    records[id] = { enabled: true, approved: manifest.capabilities ?? [] }
  }
  mkdirSync(join(dataHome, 'userData'), { recursive: true })
  writeFileSync(join(dataHome, 'userData', 'extensions.json'), JSON.stringify(records))
}

async function serve(label: string) {
  const server: Server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<h1>${label} ${req.url}</h1>`)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  return { server, origin: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` }
}

function guestText(app: ElectronApplication, origin: string): Promise<string> {
  return app.evaluate(async ({ webContents }, prefix) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith(prefix))
    return guest ? String(await guest.executeJavaScript('document.body.innerText')) : ''
  }, origin)
}

test('the keeper extension drives its panel and sidebar from the CLI', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'shop')
  const keeperDir = join(dataHome, 'fake-keeper')
  for (const d of [project, keeperDir]) mkdirSync(d, { recursive: true })

  const keeperUi = await serve('Fake Keeper')

  copyFileSync(join(FIXTURES, 'keeper', 'status-running.txt'), join(keeperDir, 'status.txt'))
  copyFileSync(join(FIXTURES, 'keeper', 'approve-pending.json'), join(keeperDir, 'approve.json'))
  writeFileSync(join(keeperDir, 'ui.txt'), `${keeperUi.origin}\n`)

  mkdirSync(join(dataHome, 'ostia'), { recursive: true })
  writeFileSync(
    join(dataHome, 'ostia', 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'shop',
          kind: 'terminal',
          workDir: project,
          activePaneId: 'pane-1',
          root: { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal', cwd: project },
        },
      ],
    }),
  )

  const launch = isolatedLaunch(dataHome)
  installApproved(dataHome, launch.env.XDG_CONFIG_HOME, ['keeper'])
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      HOME: home,
      PATH: `${join(FIXTURES, 'bin')}:${process.env.PATH}`,
      FAKE_KEEPER_DIR: keeperDir,
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    await expect(win.locator('.rail-ext-footer .ext-item')).toHaveText('2 waiting for approval', {
      timeout: 20_000,
    })
    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Keeper: Open Dashboard')
    await waitForPaletteSelection(win, 'Keeper: Open Dashboard')
    await win.keyboard.press('Enter')
    await expect(win.locator('.pane-header .title').filter({ hasText: 'Keeper' })).toBeVisible({
      timeout: 15_000,
    })
    await expect
      .poll(() => guestText(app, keeperUi.origin), { timeout: 15_000 })
      .toContain('Fake Keeper /')

    await win.getByRole('button', { name: /Notifications/ }).click({ timeout: 10_000 })
    await win
      .getByRole('list', { name: 'Notifications' })
      .getByRole('button', { name: /Keeper needs approval/ })
      .click({ timeout: 10_000 })
    await expect
      .poll(() => guestText(app, keeperUi.origin), { timeout: 15_000 })
      .toContain('Fake Keeper /approvals')

    const keeperCalls = readFileSync(join(keeperDir, 'calls.log'), 'utf8').trim().split('\n')
    expect(keeperCalls.filter((c) => c.startsWith('approve') && c !== 'approve --json')).toEqual([])
  } finally {
    await app.close()
    keeperUi.server.close()
  }
})
