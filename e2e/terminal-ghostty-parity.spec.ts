import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chords } from './chords'
import { GHOSTTY, launchGhostty } from './ghostty'
import { openedExternally, stubExternalOpener, typeLine, typeLineToEnd } from './helpers'
import { clickWith, hoverPoint, printOnFirstRow } from './terminalLinks'
import { type ElectronApplication, type Page, expect, test } from './test'

const clipboard = (app: ElectronApplication) => app.evaluate(({ clipboard: c }) => c.readText())

test(
  'Ghostty blocks: each command gets a block whose output can be copied',
  { tag: '@experimental' },
  async () => {
    test.setTimeout(60_000)
    const { app, win } = await launchGhostty()
    try {
      await typeLine(win, 'echo ghostty_first_$((1+1))')
      await typeLine(win, "printf 'ghostty_out_a\\nghostty_out_b\\n'")
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
  },
)

test(
  'Ghostty input editor: runs a command at the prompt and recalls it from history',
  { tag: '@experimental' },
  async () => {
    test.setTimeout(60_000)
    const { app, win } = await launchGhostty({
      behavior: { ...GHOSTTY.behavior, inputMode: 'editor' },
    })
    try {
      const input = win.getByRole('textbox', { name: 'Command input' })
      await expect(input).toBeVisible({ timeout: 15_000 })
      await input.click()
      await typeLine(win, 'echo ghostty_editor_$((40+2))')
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
  },
)

test(
  'Ghostty cwd: the Files panel follows the folder the shell moves to',
  { tag: '@experimental' },
  async () => {
    test.setTimeout(60_000)
    const { app, win } = await launchGhostty()
    try {
      await typeLine(win, 'cd /tmp')
      await win.locator('.topbar').getByRole('button', { name: 'Files', exact: true }).click()
      await expect(win.locator('.files-panel .crumb.current')).toHaveText('tmp', {
        timeout: 15_000,
      })
    } finally {
      await app.close()
    }
  },
)

test(
  'Ghostty find: counts matches in the output and steps through them',
  { tag: '@experimental' },
  async () => {
    test.setTimeout(60_000)
    const { app, win } = await launchGhostty()
    try {
      await typeLineToEnd(
        win,
        "clear; printf 'one zqneedle\\ntwo\\nZQNEEDLE three\\nfour zqneedle\\n'",
      )
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
  },
)

test(
  'Ghostty web links: a plain click reuses the browser pane, Ctrl adds a tab, Ctrl+Shift goes outside',
  { tag: '@experimental' },
  async () => {
    test.setTimeout(90_000)
    const requests: string[] = []
    const server = createServer((req, res) => {
      requests.push(req.url ?? '')
      res.setHeader('content-type', 'text/html')
      res.end('<title>ghostty link</title>')
    })
    await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    const { app, win } = await launchGhostty()
    try {
      await stubExternalOpener(app)
      const screen = () => win.locator('.pane-slot:not([data-hidden]) .ghostty-screen').first()
      const show = (url: string) => printOnFirstRow(win, screen(), url)
      const clickLink = async (url: string, keys: string[]): Promise<void> => {
        const target = await show(url)
        await hoverPoint(win, target)
        await clickWith(win, target, keys)
      }
      const addresses = win.locator('.browser-address')
      const shown = win.locator('.pane-slot:not([data-hidden]) .browser-address')
      const backToTerminal = async (): Promise<void> => {
        await win.locator('.pane-tab').first().click()
        await expect(screen()).toBeVisible()
      }

      await hoverPoint(win, await show(`${base}/first`))
      const hint = win.locator('[data-slot="tooltip-content"]')
      await expect(hint).toContainText('Click Open in the browser pane', { timeout: 5_000 })
      await expect(hint).toContainText('Ctrl+Click Open in a new browser tab')
      await expect(hint).toContainText('Ctrl+Shift+Click Open in the system browser')

      await clickLink(`${base}/first`, [])
      await expect(shown).toHaveValue(`${base}/first`, { timeout: 15_000 })
      await expect.poll(() => requests, { timeout: 15_000 }).toContain('/first')
      await expect(addresses).toHaveCount(1)

      await backToTerminal()
      await clickLink(`${base}/second`, [])
      await expect(shown).toHaveValue(`${base}/second`, { timeout: 15_000 })
      await expect(addresses).toHaveCount(1)

      await backToTerminal()
      await clickLink(`${base}/first`, ['Control'])
      await expect(shown).toHaveValue(`${base}/first`, { timeout: 15_000 })
      await expect(addresses).toHaveCount(2)

      await backToTerminal()
      await clickLink(`${base}/second`, ['Control', 'Shift'])
      await expect
        .poll(() => openedExternally(app), { timeout: 15_000 })
        .toEqual([`${base}/second`])
      await expect(addresses).toHaveCount(2)
    } finally {
      await app.close()
      server.close()
    }
  },
)

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

function brightness(rgb: string): number {
  return rgb
    .split(',')
    .map(Number)
    .reduce((sum, channel) => sum + channel, 0)
}

test(
  'Ghostty theme: an open terminal takes a new color scheme',
  { tag: '@experimental' },
  async () => {
    test.setTimeout(60_000)
    const { app, win } = await launchGhostty({
      appearance: { followSystem: true, lightTheme: 'ostia-light', darkTheme: 'dracula' },
    })
    try {
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'dark'
      })
      await expect(win.locator('html')).toHaveAttribute('data-theme', 'dracula')
      await expect.poll(async () => brightness(await screenBackground(win))).toBeLessThan(384)
      const dark = brightness(await screenBackground(win))
      await app.evaluate(({ nativeTheme }) => {
        nativeTheme.themeSource = 'light'
      })
      await expect(win.locator('html')).toHaveAttribute('data-theme', 'ostia-light')
      await expect.poll(async () => brightness(await screenBackground(win))).toBeGreaterThan(dark)
    } finally {
      await app.close()
    }
  },
)
