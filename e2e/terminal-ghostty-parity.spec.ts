import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'
import { chords } from './chords'
import { SOFTWARE_WEBGL, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState, emptyWorkspace } from './helpers'
import { redRowGaps } from './pixels'

const GHOSTTY = {
  behavior: { gpuAcceleration: false },
  terminal: { renderer: 'ghostty' },
  workspaces: { confirmQuit: false },
}

async function launchGhostty(
  settings: Record<string, unknown> = {},
  args: string[] = [],
): Promise<{ app: ElectronApplication; win: Page }> {
  const dataHome = freshDataHome()
  seedSettings(dataHome, { ...GHOSTTY, ...settings })
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({ ...launch, args: [...args, ...launch.args] })
  const win = await app.firstWindow()
  await emptyState(win)
    .getByRole('button', { name: /New workspace/ })
    .click()
  await emptyWorkspace(win).getByRole('button', { name: 'New terminal' }).click()
  await expect(win.locator('.pane-tab .title').first()).toHaveText('zsh', { timeout: 15_000 })
  await win.waitForTimeout(1_500)
  await win.locator('.ghostty-screen').first().click()
  return { app, win }
}

async function run(win: Page, command: string): Promise<void> {
  await win.keyboard.type(command)
  await win.keyboard.press('Enter')
}

const clipboard = (app: ElectronApplication) =>
  app.evaluate(({ clipboard: c }) => c.readText())

test('Ghostty blocks: each command gets a block whose output can be copied', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launchGhostty()
  try {
    await run(win, 'echo ghostty_first_$((1+1))')
    await run(win, "printf 'ghostty_out_a\\nghostty_out_b\\n'")
    const gutters = win.locator('.block-gutter')
    await expect(gutters).toHaveCount(2, { timeout: 15_000 })
    await gutters.nth(1).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Copy output' }).click()
    await expect.poll(() => clipboard(app)).toBe('ghostty_out_a\nghostty_out_b')
    await gutters.nth(0).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Copy command', exact: true }).click()
    await expect.poll(() => clipboard(app)).toBe('echo ghostty_first_$((1+1))')
  } finally {
    await app.close()
  }
})

test('Ghostty input editor: runs a command at the prompt and recalls it from history', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launchGhostty({
    behavior: { ...GHOSTTY.behavior, inputMode: 'editor' },
  })
  try {
    const input = win.getByRole('textbox', { name: 'Command input' })
    await expect(input).toBeVisible({ timeout: 15_000 })
    await input.click()
    await run(win, 'echo ghostty_editor_$((40+2))')
    const gutters = win.locator('.block-gutter')
    await expect(gutters).toHaveCount(1, { timeout: 15_000 })
    await expect(input).toBeVisible({ timeout: 15_000 })
    await expect(input).toHaveValue('')
    await gutters.nth(0).click({ button: 'right' })
    await win.getByRole('menuitem', { name: 'Copy output' }).click()
    await expect.poll(() => clipboard(app)).toBe('ghostty_editor_42')
    await input.click()
    await win.keyboard.press('ArrowUp')
    await expect(input).toHaveValue('echo ghostty_editor_$((40+2))')
  } finally {
    await app.close()
  }
})

test('Ghostty cwd: the Files panel follows the folder the shell moves to', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launchGhostty()
  try {
    await run(win, 'cd /tmp')
    await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
    await expect(win.locator('.files-panel .crumb.current')).toHaveText('tmp', { timeout: 15_000 })
  } finally {
    await app.close()
  }
})

test('Ghostty find: counts matches in the output and steps through them', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launchGhostty()
  try {
    await run(win, "clear; printf 'one zqneedle\\ntwo\\nZQNEEDLE three\\nfour zqneedle\\n'")
    await win.waitForTimeout(500)
    await win.keyboard.press(chords.find)
    const find = win.getByRole('textbox', { name: 'Find in terminal' })
    await expect(find).toBeFocused({ timeout: 5_000 })
    await win.keyboard.type('zqneedle')
    const count = win.locator('.term-find-count')
    await expect(count).toHaveText('1/3', { timeout: 5_000 })
    await win.keyboard.press('Enter')
    await expect(count).toHaveText('2/3')
    await win.keyboard.press('Shift+Enter')
    await expect(count).toHaveText('1/3')
    await find.fill('zqabsent')
    await expect(count).toHaveText('No results')
  } finally {
    await app.close()
  }
})

test('Ghostty web links: the hint shows on hover and Ctrl+click opens a browser pane', async () => {
  test.setTimeout(60_000)
  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    res.setHeader('content-type', 'text/html')
    res.end('<title>ghostty link</title>')
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/ghostty`
  const { app, win } = await launchGhostty({ browser: { openTerminalLinks: true } })
  try {
    await run(win, `clear; printf '%s\\n' '${url}'`)
    await win.waitForTimeout(800)
    const box = await win.locator('.ghostty-screen').first().boundingBox()
    if (!box) throw new Error('terminal screen not found')
    const target = { x: box.x + 30, y: box.y + 8 }
    await win.mouse.move(target.x, target.y + 80)
    await win.mouse.move(target.x, target.y, { steps: 6 })
    const hint = win.locator('[data-slot="tooltip-content"]')
    await expect(hint).toContainText('Ctrl+Click Open in a browser pane', { timeout: 5_000 })
    await win.keyboard.down('Control')
    await win.mouse.click(target.x, target.y)
    await win.keyboard.up('Control')
    await expect(win.locator('.browser-address')).toHaveValue(url, { timeout: 15_000 })
    await expect.poll(() => requests, { timeout: 15_000 }).toContain('/ghostty')
  } finally {
    await app.close()
    server.close()
  }
})

async function screenBackground(win: Page): Promise<string> {
  const screen = win.locator('.ghostty-host').first()
  const png = await screen.screenshot()
  return win.evaluate(async (b64) => {
    const img = new Image()
    img.src = `data:image/png;base64,${b64}`
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = img.width
    canvas.height = img.height
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.drawImage(img, 0, 0)
    const [r, g, b] = ctx.getImageData(img.width - 20, img.height - 20, 1, 1).data
    return `${r},${g},${b}`
  }, png.toString('base64'))
}

test('Ghostty theme: an open terminal takes a new color scheme', async () => {
  test.setTimeout(60_000)
  const { app, win } = await launchGhostty({
    appearance: { followSystem: true, lightTheme: 'ostia-light', darkTheme: 'dracula' },
  })
  try {
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'dark'
    })
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'dracula')
    await win.waitForTimeout(500)
    const dark = await screenBackground(win)
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'light'
    })
    await expect(win.locator('html')).toHaveAttribute('data-theme', 'ostia-light')
    await expect.poll(() => screenBackground(win)).not.toBe(dark)
    const light = (await screenBackground(win)).split(',').map(Number)
    expect(light.reduce((a, b) => a + b, 0)).toBeGreaterThan(dark.split(',').map(Number).reduce((a, b) => a + b, 0))
  } finally {
    await app.close()
  }
})

test('Ghostty on the GPU keeps drawing glyphs from before its atlas grew', async () => {
  test.setTimeout(90_000)
  const { app, win } = await launchGhostty(
    { behavior: { gpuAcceleration: true } },
    [SOFTWARE_WEBGL],
  )
  try {
    await expect(win.locator('.ghostty-host canvas')).toHaveCount(2)
    const redBlocks = "clear; printf '\\033[38;2;255;0;0m%s\\n%s\\n%s\\033[0m\\n' ███ ███ ███"
    const host = win.locator('.ghostty-host').first()
    await run(win, redBlocks)
    await expect.poll(async () => redRowGaps(await host.screenshot(), win)).toBe(0)
    await run(win, 'clear; for i in {19968..21500}; do printf "\\\\U$(printf %x $i)"; done; echo')
    await win.waitForTimeout(2_000)
    await run(win, redBlocks)
    await expect.poll(async () => redRowGaps(await host.screenshot(), win)).toBe(0)
  } finally {
    await app.close()
  }
})
