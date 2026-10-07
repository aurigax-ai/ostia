import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { emptyState } from './helpers'

const VERSION = '999.0.0'
const RELEASE_URL = `https://github.com/aurigax-ai/ostia/releases/tag/v${VERSION}`
const STARTUP_CHECK_MS = 5_000

interface FakeGitHub {
  url: string
  requests: Array<{ path: string | undefined; userAgent: string | undefined }>
  close: () => Promise<void>
}

async function startFakeGitHub(): Promise<FakeGitHub> {
  const requests: FakeGitHub['requests'] = []
  const server: Server = createServer((req, res) => {
    requests.push({ path: req.url, userAgent: req.headers['user-agent'] })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        tag_name: `v${VERSION}`,
        html_url: RELEASE_URL,
        draft: false,
        prerelease: false,
      }),
    )
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function launch(
  github: FakeGitHub,
  dataHome: string,
): Promise<{ app: ElectronApplication; win: Page }> {
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launchOptions,
    env: { ...launchOptions.env, OSTIA_RELEASE_API_URL: github.url },
  })
  const win = await app.firstWindow()
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    Object.assign(globalThis, { __openedExternally: opened })
    shell.openExternal = async (url: string) => {
      opened.push(url)
    }
  })
  await win.waitForLoadState('domcontentloaded')
  await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
  return { app, win }
}

const openedExternally = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => (globalThis as unknown as { __openedExternally: string[] }).__openedExternally)

const releaseButton = (win: Page) =>
  win.locator('.update-notice').getByRole('button', { name: `Version ${VERSION} is available` })

async function openAbout(win: Page) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'About' }).click()
  return settings
}

test('a newer release shows a notice that opens its page and stays skipped after a restart', async () => {
  const github = await startFakeGitHub()
  const dataHome = freshDataHome()
  let { app, win } = await launch(github, dataHome)
  try {
    await expect(releaseButton(win)).toBeVisible({ timeout: 20_000 })
    expect(github.requests).toHaveLength(1)
    expect(github.requests[0].path).toBe('/repos/aurigax-ai/ostia/releases/latest')
    expect(github.requests[0].userAgent).toMatch(/^ostia\/\d+\.\d+\.\d+/)

    await releaseButton(win).click()
    await expect.poll(() => openedExternally(app)).toEqual([RELEASE_URL])

    await win.locator('.update-notice').getByRole('button', { name: 'Skip this version' }).click()
    await expect(win.locator('.update-notice')).toHaveCount(0)

    await app.close()
    ;({ app, win } = await launch(github, dataHome))
    await expect.poll(() => github.requests.length, { timeout: 20_000 }).toBe(2)
    const settings = await openAbout(win)
    await settings.getByRole('button', { name: 'Check for updates' }).click()
    await expect(settings.getByText(`Version ${VERSION} is available`)).toBeVisible()
    await expect(win.locator('.update-notice')).toHaveCount(0)
  } finally {
    await app.close()
    await github.close()
  }
})

test('with the automatic check off nothing is asked until the human checks from About', async () => {
  const github = await startFakeGitHub()
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, checkForUpdates: false },
  })
  const { app, win } = await launch(github, dataHome)
  try {
    const settings = await openAbout(win)
    await expect(
      settings.getByRole('switch', { name: 'Check for updates automatically' }),
    ).not.toBeChecked()
    await win.waitForTimeout(STARTUP_CHECK_MS + 2_000)
    expect(github.requests).toHaveLength(0)

    await settings.getByRole('button', { name: 'Check for updates' }).click()
    await expect(settings.getByText(`Version ${VERSION} is available`)).toBeVisible()
    expect(github.requests).toHaveLength(1)

    await settings.getByRole('button', { name: 'View release' }).click()
    await expect.poll(() => openedExternally(app)).toEqual([RELEASE_URL])
  } finally {
    await app.close()
    await github.close()
  }
})
