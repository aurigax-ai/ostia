import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GHOSTTY, launchGhostty } from './ghostty'
import { expectHeld, openedExternally, stubExternalOpener, terminalTab, typeLine } from './helpers'
import { cellPoint, clickWith, hoverPoint, printOnFirstRow } from './terminalLinks'
import { type ElectronApplication, expect, test } from './test'

const clipboard = (app: ElectronApplication) => app.evaluate(({ clipboard: c }) => c.readText())

test('Ghostty blocks: each command gets a block whose output can be copied', {
  tag: '@experimental',
}, async () => {
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
})

test('Ghostty input editor: runs a command at the prompt and recalls it from history', {
  tag: '@experimental',
}, async () => {
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
})

test('Ghostty cwd: the Files panel follows the folder the shell moves to', {
  tag: '@experimental',
}, async () => {
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
})

test('Ghostty web links: a plain click reuses the browser pane, Ctrl adds a tab, Ctrl+Shift goes outside, and a mouse-reporting program never sees the Ctrl+click', {
  tag: '@experimental',
}, async () => {
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
      await terminalTab(win).click()
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
    await expect.poll(() => openedExternally(app), { timeout: 15_000 }).toEqual([`${base}/second`])
    await expect(addresses).toHaveCount(2)

    await backToTerminal()
    const dir = mkdtempSync(join(tmpdir(), 'ostia-mouse-'))
    const size = join(dir, 'size')
    const reports = join(dir, 'reports')
    const reported = (): string[] =>
      existsSync(reports) ? (readFileSync(reports, 'utf8').match(/\[<[\d;]+[Mm]/g) ?? []) : []
    await screen().click()
    await typeLine(
      win,
      `clear; stty size > ${size}; printf '\\033[?1000h\\033[?1006h\\033]8;;${base}/osc\\033\\\\docs page\\033]8;;\\033\\\\\\n'; stty raw -echo; cat > ${reports}`,
    )
    await expect
      .poll(() => existsSync(size) && readFileSync(size, 'utf8').trim())
      .toMatch(/^\d+ \d+$/)
    const [rows, cols] = readFileSync(size, 'utf8').trim().split(' ').map(Number)
    const link = await cellPoint(screen(), { rows, cols }, 2, 0)
    const blank = await cellPoint(screen(), { rows, cols }, 2, 3)
    const blankClick = ['[<0;3;4M', '[<0;3;4m']

    await hoverPoint(win, link)
    await expect(hint).toContainText(`${base}/osc`, { timeout: 5_000 })
    await clickWith(win, blank, [])
    await expect.poll(reported, { timeout: 10_000 }).toEqual(blankClick)

    await hoverPoint(win, link)
    await clickWith(win, link, ['Control'])
    await expect(shown).toHaveValue(`${base}/osc`, { timeout: 15_000 })
    await expect.poll(() => requests, { timeout: 15_000 }).toContain('/osc')
    await expect(addresses).toHaveCount(3)

    await backToTerminal()
    await clickWith(win, blank, [])
    await expect.poll(reported, { timeout: 10_000 }).toEqual([...blankClick, ...blankClick])
    expect(await openedExternally(app)).toEqual([`${base}/second`])
  } finally {
    await app.close()
    server.close()
  }
})

test('Ghostty scroll: scrolling up while the program keeps writing holds the view until the user types', {
  tag: '@experimental',
}, async () => {
  test.setTimeout(60_000)
  const ready = join(mkdtempSync(join(tmpdir(), 'ostia-scroll-')), 'ready')
  const { app, win } = await launchGhostty()
  try {
    await typeLine(
      win,
      `seq -f 'static %g' 1 300; touch '${ready}'; while :; do echo tick; sleep 0.05; done`,
    )
    await expect.poll(() => existsSync(ready), { timeout: 15_000 }).toBe(true)
    const box = await win.locator('.ghostty-host').first().boundingBox()
    if (!box) throw new Error('terminal host not found')
    const clip = { x: box.x, y: box.y, width: box.width * 0.7, height: box.height }
    const view = async (): Promise<string> =>
      createHash('sha1')
        .update(await win.screenshot({ clip }))
        .digest('hex')
    await win.locator('.ghostty-screen').first().hover()
    await win.mouse.wheel(0, -20_000)
    let seen = await view()
    await expect
      .poll(async () => {
        const before = seen
        seen = await view()
        return seen === before
      })
      .toBe(true)
    const scrolledUp = seen
    await expectHeld(view, scrolledUp, 3_000, 'the view moved while the program kept writing')
    await win.keyboard.type('a')
    await expect.poll(view, { timeout: 15_000 }).not.toBe(scrolledUp)
  } finally {
    await app.close()
  }
})
