import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { type Server, createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '../src/shared/product'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { waitForPaletteSelection } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const FIXTURES = resolve(__dirname, '../test/fixtures/tools')
const MARKETPLACE = resolve(__dirname, '../out/marketplace/extensions')
const FAKE_BIN = join(FIXTURES, 'bin', 'trellis')
const DAEMON_TOKEN = 'TESTTOKEN'

function installApproved(dataHome: string, configHome: string, id: string): void {
  const target = join(configHome, PRODUCT_NAME, 'extensions', id)
  cpSync(join(MARKETPLACE, id), target, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(target, 'ostia.json'), 'utf8'))
  mkdirSync(join(dataHome, 'userData'), { recursive: true })
  writeFileSync(
    join(dataHome, 'userData', 'extensions.json'),
    JSON.stringify({ [id]: { enabled: true, approved: manifest.capabilities ?? [] } }),
  )
}

async function serveDaemon(trellisDir: string): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const ref = /^\/api\/p\/DEMO\/b\/demo\/cards\/([A-Z0-9-]+)$/.exec(req.url ?? '')?.[1]
    const authed = req.headers['x-trellis-token'] === DAEMON_TOKEN
    const state = join(trellisDir, 'state.json')
    if (!ref || !authed || !existsSync(state)) {
      res.writeHead(authed ? 404 : 401, { 'content-type': 'application/json' })
      res.end('{"error":"refused"}')
      return
    }
    const comments = JSON.parse(readFileSync(state, 'utf8')).comments[ref] ?? []
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ comments, events: [] }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  return { server, origin: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` }
}

function panelEval(app: ElectronApplication, script: string): Promise<string> {
  return app.evaluate(async ({ webContents }, code) => {
    const guest = webContents
      .getAllWebContents()
      .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
    return guest ? String(await guest.executeJavaScript(code)) : ''
  }, script)
}

test('the trellis panel draws the board, a card and the vault from the CLI and follows its events', async () => {
  const dataHome = freshDataHome()
  const home = join(dataHome, 'home')
  const project = join(home, 'shop')
  const trellisDir = join(dataHome, 'fake-trellis')
  for (const d of [project, trellisDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(project, '.trellis'), '/DEMO\n')
  for (const f of readdirSync(join(FIXTURES, 'trellis'))) {
    copyFileSync(join(FIXTURES, 'trellis', f), join(trellisDir, f))
  }
  const daemon = await serveDaemon(trellisDir)
  writeFileSync(join(trellisDir, 'daemon-up'), '')
  writeFileSync(
    join(trellisDir, 'daemon-running.json'),
    readFileSync(join(FIXTURES, 'trellis', 'daemon-running.json'), 'utf8').replace(
      'http://127.0.0.1:7788',
      daemon.origin,
    ),
  )
  writeFileSync(join(trellisDir, 'consumers.json'), '[{"name":"ostia","cursor":0,"lag":0}]')
  writeFileSync(
    join(trellisDir, 'follow.jsonl'),
    `${JSON.stringify({
      seq: 1,
      ts: 1789419958656,
      actor: 'agent:e2e',
      entity: 'card',
      ref: 'DEMO-3',
      title: 'Write the rollback runbook',
      action: 'moved',
      field: 'column',
      old: 'in-progress',
      new: 'review',
    })}\n`,
  )
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
  installApproved(dataHome, launch.env.XDG_CONFIG_HOME, 'trellis')
  const fakeEnv = {
    PATH: `${join(FIXTURES, 'bin')}:${process.env.PATH}`,
    FAKE_TRELLIS_DIR: trellisDir,
  }
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: home, ...fakeEnv },
  })
  const calls = (): string[] =>
    readFileSync(join(trellisDir, 'calls.log'), 'utf8').trim().split('\n')
  const panel = (script: string): Promise<string> => panelEval(app, script)
  const panelText = (): Promise<string> => panel('document.body.innerText')
  const refsIn = (column: string): Promise<string> =>
    panel(
      `[...document.querySelectorAll('[data-column="${column}"] [data-ref]')].map((el) => el.dataset.ref).join(',')`,
    )
  const paletteRun = async (title: string): Promise<void> => {
    const win = await app.firstWindow()
    await win.keyboard.press('Control+Shift+P')
    await win.locator('[data-slot="command-input"]').fill(title)
    await waitForPaletteSelection(win, title)
    await win.keyboard.press('Enter')
  }

  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')

    await expect(
      win
        .locator('.topbar-right .workspace-chips')
        .getByRole('button', { name: /^Trellis cards: 4/ }),
    ).toBeVisible({ timeout: 20_000 })

    await paletteRun('Trellis: Open Board')
    const panelTitle = win.locator('.pane-header .title').filter({ hasText: 'Trellis' })
    await expect(panelTitle).toBeVisible({ timeout: 15_000 })
    await expect.poll(panelText, { timeout: 15_000 }).toContain('Checkout fails on an empty cart')
    expect(await refsIn('backlog')).toBe('DEMO-5,DEMO-3')
    expect(await refsIn('in-progress')).toBe('DEMO-1')
    expect(await refsIn('review')).toBe('DEMO-2')
    expect(await refsIn('done')).toBe('DEMO-4')
    expect(await panel(`document.querySelector('[data-ref="DEMO-1"]').innerText`)).toContain(
      'Claimed by agent 5f3c9a',
    )

    await panel(`document.querySelector('[data-ref="DEMO-2"]').click(); 'ok'`)
    await expect
      .poll(() => panel(`document.querySelector('.detail')?.innerText ?? ''`), { timeout: 15_000 })
      .toContain('Ready for review: deploy --dry-run prints the plan.')
    const detail = await panel(`document.querySelector('.detail').innerText`)
    expect(detail).toContain('Dry run for deploy')
    expect(detail).toContain('<script>alert(1)</script>')
    expect(
      await panel(
        `JSON.stringify({
          scripts: document.querySelectorAll('.detail script').length,
          links: [...document.querySelectorAll('.detail .markdown a')].map((a) => a.getAttribute('href')),
          boxes: document.querySelectorAll('.detail .markdown input[type=checkbox][disabled]').length,
        })`,
      ),
    ).toBe(JSON.stringify({ scripts: 0, links: ['https://example.com/guide'], boxes: 2 }))

    await panel(`(() => {
      const move = document.querySelector('select[data-key="move"]')
      move.value = 'done'
      move.dispatchEvent(new Event('change', { bubbles: true }))
      return 'ok'
    })()`)
    await expect.poll(() => refsIn('done'), { timeout: 15_000 }).toBe('DEMO-2,DEMO-4')
    expect(await refsIn('review')).toBe('')
    await expect.poll(calls, { timeout: 15_000 }).toContain('card move DEMO-2 --column=done --json')
    await expect
      .poll(() => panel(`document.querySelector('select[data-key="move"]').value`), {
        timeout: 15_000,
      })
      .toBe('done')

    await panel(`(() => {
      const box = document.querySelector('textarea[data-key="comment"]')
      box.value = 'Shipped from the panel @/etc/hostname'
      box.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-key="comment-send"]').click()
      return 'ok'
    })()`)
    await expect
      .poll(() => panel(`document.querySelector('.thread').innerText`), { timeout: 15_000 })
      .toContain('Shipped from the panel @/etc/hostname')
    expect(await panel(`document.querySelector('.thread').innerText`)).toContain('you')
    expect(await panel(`document.querySelector('textarea[data-key="comment"]').value`)).toBe('')

    execFileSync(FAKE_BIN, ['card', 'move', 'DEMO-5', '--column=in-progress'], {
      env: { ...process.env, ...fakeEnv, TRELLIS_AGENT: 'agent:e2e' },
    })
    appendFileSync(
      join(trellisDir, 'follow.jsonl'),
      `${JSON.stringify({
        seq: 2,
        ts: Date.now(),
        actor: 'agent:e2e',
        entity: 'card',
        ref: 'DEMO-5',
        title: 'Rename the config keys',
        action: 'moved',
        field: 'column',
        old: 'backlog',
        new: 'in-progress',
      })}\n`,
    )
    await expect.poll(() => refsIn('in-progress'), { timeout: 15_000 }).toBe('DEMO-1,DEMO-5')
    expect(await refsIn('backlog')).toBe('DEMO-3')

    await paletteRun('Trellis: Open Card')
    await expect(win.locator('[data-slot="command-input"]')).toHaveAttribute(
      'placeholder',
      'Card id, for example SHOP-12',
    )
    await win.keyboard.type('demo-1')
    await win.keyboard.press('Enter')
    await expect
      .poll(() => panel(`document.querySelector('.detail-title')?.innerText ?? ''`), {
        timeout: 15_000,
      })
      .toBe('Checkout fails on an empty cart')
    await expect(panelTitle).toHaveCount(1)

    await win.getByRole('button', { name: /Notifications/ }).click({ timeout: 10_000 })
    await win
      .getByRole('list', { name: 'Notifications' })
      .getByRole('button', { name: /ready for your review: DEMO-3/ })
      .click({ timeout: 10_000 })
    await expect
      .poll(() => panel(`document.querySelector('.detail-title')?.innerText ?? ''`), {
        timeout: 15_000,
      })
      .toBe('Write the rollback runbook')
    expect(await panel(`document.querySelector('.relations').innerText`)).toContain('DEMO-1')
    await expect(panelTitle).toHaveCount(1)

    await paletteRun('Trellis: Open Vault')
    await expect.poll(panelText, { timeout: 15_000 }).toContain('Database concurrency')
    await panel(
      `document.querySelector('[data-slug="ops/deploy/rollback-a-deploy"]').click(); 'ok'`,
    )
    await expect
      .poll(() => panel(`document.querySelector('.entry-detail')?.innerText ?? ''`), {
        timeout: 15_000,
      })
      .toContain('Redeploy the previous tag.')

    await paletteRun('Trellis: Open Board')
    await expect.poll(() => refsIn('in-progress'), { timeout: 15_000 }).toBe('DEMO-1,DEMO-5')
    await expect(panelTitle).toHaveCount(1)

    expect(calls().filter((c) => c.startsWith('ui') || c.startsWith('daemon start'))).toEqual([])
    expect(calls().filter((c) => c.startsWith('card comment DEMO-2 --body @'))).toHaveLength(1)
  } finally {
    await app.close()
    daemon.server.close()
  }
})
