import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PRODUCT_NAME } from '@aurigax-ai/ostia-extension-sdk/contract/product'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { installApproved, panelEval, waitForPaletteSelection } from './helpers'
import { type ElectronApplication, _electron as electron, expect, test } from './test'

const FIXTURES = resolve(__dirname, '../test/fixtures/tools')
const EXTENSION = 'screens'
const COLOUR = [0, 128, 255]

async function clickInPanel(app: ElectronApplication, x: number, y: number): Promise<void> {
  await app.evaluate(
    ({ webContents }, [px, py]) => {
      const guest = webContents
        .getAllWebContents()
        .find((wc) => wc.getType() === 'webview' && wc.getURL().startsWith('http://127.0.0.1'))
      if (!guest) throw new Error('no panel guest')
      guest.sendInputEvent({ type: 'mouseMove', x: px, y: py })
      guest.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 })
      guest.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 })
    },
    [x, y] as const,
  )
}

const pressButton = (label: string): string =>
  `(() => { const b = [...document.querySelectorAll('button')].find((e) => e.textContent === ${JSON.stringify(label)}); if (!b || b.disabled) return 'missing'; b.click(); return 'ok' })()`

const hasButton = (label: string): string =>
  `[...document.querySelectorAll('button')].some((e) => e.textContent === ${JSON.stringify(label)}) ? 'yes' : 'no'`

const canvasCentre = `(() => {
  const c = document.querySelector('#view canvas')
  if (!c || !c.width) return ''
  const r = c.getBoundingClientRect()
  const [red, green, blue] = c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data
  return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), rgb: [red, green, blue] })
})()`

test('SCX-C4 the Screens panel draws the screen with noVNC, and only Take over lets the human’s pointer through', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const project = join(launch.home, 'desk')
  const fakeDir = join(dataHome, 'fake-screens')
  const runtimeDir = join(fakeDir, 'run')
  for (const d of [project, fakeDir]) mkdirSync(d, { recursive: true })
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 })
  mkdirSync(join(dataHome, PRODUCT_NAME), { recursive: true })
  writeFileSync(
    join(dataHome, PRODUCT_NAME, 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'desk',
          kind: 'terminal',
          workDir: project,
          activePaneId: 'pane-1',
          root: { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal', cwd: project },
        },
      ],
    }),
  )
  installApproved(dataHome, launch.env.XDG_CONFIG_HOME, EXTENSION)
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      PATH: `${join(FIXTURES, 'bin')}:${process.env.PATH}`,
      FAKE_SCREENS_DIR: fakeDir,
      XDG_RUNTIME_DIR: runtimeDir,
      FAKE_SCREENS_COLOUR: COLOUR.join(','),
    },
  })
  const panel = (script: string): Promise<string> => panelEval(app, script)
  const pointers = (): { type: string; held: boolean }[] => {
    const state = JSON.parse(readFileSync(join(fakeDir, 'state.json'), 'utf8'))
    const file = join(fakeDir, `input-${state.screens[0].id}.jsonl`)
    if (!existsSync(file)) return []
    return readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => event.type === 'pointer')
  }

  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(win.locator('.terminal-text').filter({ hasText: '~/desk' })).toHaveCount(1, {
      timeout: 30_000,
    })
    await win.keyboard.press(chords.palette)
    await win.locator('[data-slot="command-input"]').fill('Screens: Open Panel')
    await waitForPaletteSelection(win, 'Screens: Open Panel')
    await win.keyboard.press('Enter')

    await expect.poll(() => panel(pressButton('New screen')), { timeout: 20_000 }).toBe('ok')
    await expect.poll(() => panel(pressButton('View')), { timeout: 15_000 }).toBe('ok')
    await expect
      .poll(async () => JSON.parse((await panel(canvasCentre)) || '{"rgb":[]}').rgb, {
        timeout: 20_000,
      })
      .toEqual(COLOUR)
    const { x, y } = JSON.parse(await panel(canvasCentre)) as { x: number; y: number }

    await clickInPanel(app, x, y)
    expect(await panel(pressButton('Take over'))).toBe('ok')
    await expect.poll(() => panel(hasButton('Give back')), { timeout: 10_000 }).toBe('yes')
    expect(await panel(`document.activeElement?.closest('#view') ? 'in-view' : 'outside'`)).toBe(
      'in-view',
    )
    await clickInPanel(app, x, y)
    await expect
      .poll(() => pointers().filter((e) => e.held).length, { timeout: 10_000 })
      .toBeGreaterThan(0)
    expect(pointers().filter((e) => !e.held)).toEqual([])

    expect(await panel(pressButton('Give back'))).toBe('ok')
    await expect.poll(() => panel(hasButton('Take over')), { timeout: 10_000 }).toBe('yes')
    const held = pointers().length
    await clickInPanel(app, x, y)
    expect(await panel(pressButton('Take over'))).toBe('ok')
    await expect.poll(() => panel(hasButton('Give back')), { timeout: 10_000 }).toBe('yes')
    await clickInPanel(app, x, y)
    await expect.poll(() => pointers().length, { timeout: 10_000 }).toBeGreaterThan(held)
    expect(pointers().filter((e) => !e.held)).toEqual([])
  } finally {
    writeFileSync(join(fakeDir, 'daemon.off'), '')
    const daemon = join(fakeDir, 'daemon.pid')
    if (existsSync(daemon)) process.kill(Number(readFileSync(daemon, 'utf8')), 'SIGKILL')
    await app.close()
  }
})
