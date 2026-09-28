import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { type Server, createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test'
import { freshDataHome, isolatedLaunch } from './dataHome'

const FIXTURES = resolve(__dirname, '../test/fixtures/tools')

async function serve(label: string, check?: (headers: Record<string, unknown>) => boolean) {
  const server: Server = createServer((req, res) => {
    const ok = check ? check(req.headers) : true
    res.writeHead(ok ? 200 : 401, { 'content-type': 'text/html; charset=utf-8' })
    res.end(ok ? `<h1>${label} ${req.url}</h1>` : 'no token')
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

test('trellis and keeper extensions drive their panels and sidebar from the CLIs', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'shop')
  const trellisDir = join(dataHome, 'fake-trellis')
  const keeperDir = join(dataHome, 'fake-keeper')
  for (const d of [project, trellisDir, keeperDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(project, '.trellis'), '/DEMO\n')

  const trellisUi = await serve('Fake Trellis', (h) => h['x-trellis-token'] === 'TESTTOKEN')
  const keeperUi = await serve('Fake Keeper')

  for (const f of readdirSync(join(FIXTURES, 'trellis'))) {
    copyFileSync(join(FIXTURES, 'trellis', f), join(trellisDir, f))
  }
  writeFileSync(join(trellisDir, 'daemon-up'), '')
  writeFileSync(
    join(trellisDir, 'ui.json'),
    JSON.stringify({ started: false, url: `${trellisUi.origin}/?token=TESTTOKEN` }),
  )
  writeFileSync(
    join(trellisDir, 'daemon-running.json'),
    readFileSync(join(FIXTURES, 'trellis', 'daemon-running.json'), 'utf8').replace(
      'http://127.0.0.1:7788',
      trellisUi.origin,
    ),
  )
  writeFileSync(join(trellisDir, 'consumers.json'), '[{"name":"pine","cursor":0,"lag":0}]')
  copyFileSync(join(FIXTURES, 'keeper', 'status-running.txt'), join(keeperDir, 'status.txt'))
  copyFileSync(join(FIXTURES, 'keeper', 'approve-pending.json'), join(keeperDir, 'approve.json'))
  writeFileSync(join(keeperDir, 'ui.txt'), `${keeperUi.origin}\n`)

  mkdirSync(join(dataHome, 'pine'), { recursive: true })
  writeFileSync(
    join(dataHome, 'pine', 'workspaces.json'),
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
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      HOME: home,
      PATH: `${join(FIXTURES, 'bin')}:${process.env.PATH}`,
      FAKE_TRELLIS_DIR: trellisDir,
      FAKE_KEEPER_DIR: keeperDir,
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    await expect(win.locator('.rail-ext-footer .ext-item')).toHaveText('2 waiting for approval', {
      timeout: 20_000,
    })
    await expect(win.locator('.ext-item', { hasText: '4 open' })).toBeVisible({ timeout: 20_000 })

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Trellis: Open Board')
    await win.keyboard.press('Enter')
    await expect(win.locator('.pane-header .title').filter({ hasText: 'Trellis' })).toBeVisible({
      timeout: 15_000,
    })
    await expect
      .poll(() => guestText(app, 'http://127.0.0.1'), { timeout: 15_000 })
      .toContain('Fake Trellis /p/DEMO')

    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill('Keeper: Open Dashboard')
    await win.keyboard.press('Enter')
    await expect(win.locator('.pane-header .title').filter({ hasText: 'Keeper' })).toBeVisible({
      timeout: 15_000,
    })
    await expect
      .poll(() => guestText(app, keeperUi.origin), { timeout: 15_000 })
      .toContain('Fake Keeper /')

    const keeperCalls = readFileSync(join(keeperDir, 'calls.log'), 'utf8').trim().split('\n')
    expect(keeperCalls.filter((c) => c.startsWith('approve') && c !== 'approve --json')).toEqual([])
  } finally {
    await app.close()
    trellisUi.server.close()
    keeperUi.server.close()
  }
})
