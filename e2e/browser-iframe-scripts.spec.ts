import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

const SEEN_AT_LOAD = '<script>window.__seenAtLoad = window.__ostiaErrCatcher === true</script>'

function pages(port: number): Record<string, string> {
  return {
    '/': `<!doctype html><title>Iframe fixture</title>${SEEN_AT_LOAD}<iframe src="http://127.0.0.1:${port}/child"></iframe>`,
    '/child': `<!doctype html>${SEEN_AT_LOAD}<iframe src="http://localhost:${port}/grandchild"></iframe>`,
    '/grandchild': `<!doctype html>${SEEN_AT_LOAD}grandchild`,
  }
}

function serve(): Promise<Server> {
  const server = createServer((req, res) => {
    const body = pages((server.address() as AddressInfo).port)[req.url ?? '']
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' })
    res.end(body ?? '')
  })
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok(server)))
}

interface FrameReport {
  path: string
  ownProcess: boolean
  catcher: boolean
  seenAtLoad: boolean
}

test('page scripts reach cross-site iframes before their first script runs', async () => {
  test.setTimeout(120_000)
  const server = await serve()
  const pageUrl = `http://localhost:${(server.address() as AddressInfo).port}/`
  const app = await electron.launch(isolatedLaunch(freshDataHome()))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.keyboard.press(chords.palette)
    await win.locator('[data-slot="command-input"]').fill('Open Browser')
    await waitForPaletteSelection(win, 'Open Browser')
    await win.keyboard.press('Enter')
    const address = win.getByRole('textbox', { name: 'Address' })
    await expect(address).toBeVisible({ timeout: 15_000 })
    await address.fill(pageUrl)
    await address.press('Enter')

    const frames = (): Promise<FrameReport[] | null> =>
      app
        .evaluate(async ({ webContents }, url) => {
          const guest = webContents
            .getAllWebContents()
            .find((wc) => wc.getType() === 'webview' && wc.getURL() === url)
          if (!guest) return null
          const reports: FrameReport[] = []
          for (const frame of guest.mainFrame.framesInSubtree) {
            const state = (await frame.executeJavaScript(
              '[window.__ostiaErrCatcher === true, window.__seenAtLoad === true]',
            )) as [boolean, boolean]
            reports.push({
              path: new URL(frame.url).pathname,
              ownProcess: frame.parent ? frame.processId !== frame.parent.processId : false,
              catcher: state[0],
              seenAtLoad: state[1],
            })
          }
          return reports.sort((a, b) => a.path.localeCompare(b.path))
        }, pageUrl)
        .catch(() => null)

    await expect.poll(frames, { timeout: 20_000 }).toEqual([
      { path: '/', ownProcess: false, catcher: true, seenAtLoad: true },
      { path: '/child', ownProcess: true, catcher: true, seenAtLoad: true },
      { path: '/grandchild', ownProcess: true, catcher: true, seenAtLoad: true },
    ])
  } finally {
    await app.close()
    server.close()
  }
})
