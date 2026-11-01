import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { chords } from '../chords'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, seedSettings } from '../dataHome'
import { openWorkspace, quitApp, shownTerminal, typeLineToEnd } from '../helpers'
import { clickWith, hoverPoint, linkPoint } from '../terminalLinks'
import { expect, test } from '../test'
import { launchPlain, measure } from './flowApp'
import { RUNS, Samples, WARMUP } from './flowResults'

test('bench links: path and web link click to the opened target', async () => {
  test.setTimeout(600_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, CANVAS_RENDERER_SETTINGS)
  const home = join(dataHome, 'home')
  mkdirSync(join(home, 'notes'), { recursive: true })
  writeFileSync(
    join(home, 'notes', 'app.ts'),
    `${Array.from({ length: 40 }, (_, i) => `const line${i + 1} = ${i + 1}`).join('\n')}\n`,
  )
  const server = createServer((_req, res) => res.end('ok'))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  const { app, win } = await launchPlain(dataHome)
  const samples = new Samples()
  try {
    await openWorkspace(win)
    await shownTerminal(win).click()
    for (let i = 0; i < RUNS + WARMUP; i++) {
      await typeLineToEnd(win, "clear; printf 'error at notes/app.ts:27:7\\n'")
      const path = await linkPoint(win, /^error at notes\/app\.ts:27:7\s*$/, 'app.ts')
      await hoverPoint(win, path)
      const editor = await measure(win, {
        start: { type: 'mousedown', sel: '.ghostty-host' },
        ends: { open: [{ sel: '.monaco-editor .active-line-number', text: '^27$', shown: true }] },
        act: () => clickWith(win, path, ['Control']),
      })
      await win.keyboard.press(chords.closePane)
      await expect(win.locator('.monaco-editor')).toHaveCount(0, { timeout: 15_000 })
      await shownTerminal(win).click()
      const url = `http://127.0.0.1:${port}/l${i}`
      await typeLineToEnd(win, `clear; printf '%s\\n' '${url}'`)
      const web = await linkPoint(
        win,
        new RegExp(`^http://127\\.0\\.0\\.1:${port}/l${i}\\s*$`),
        `l${i}`,
      )
      await hoverPoint(win, web)
      const webviews = await win.locator('webview').count()
      const browser = await measure(win, {
        start: { type: 'mousedown', sel: '.ghostty-host' },
        ends: { open: [{ sel: 'webview', min: webviews + 1 }] },
        act: () => clickWith(win, web, ['Control']),
      })
      const opened = win.locator('.pane-tab').last()
      await opened.hover()
      await opened.locator('.pane-tab-close').click()
      await expect(win.locator('webview')).toHaveCount(webviews, { timeout: 15_000 })
      await shownTerminal(win).click()
      if (i < WARMUP) continue
      samples.add('link.path-editor', editor.open)
      samples.add('link.web-browser', browser.open)
    }
  } finally {
    await quitApp(app)
    server.close()
  }
  samples.flush()
})
