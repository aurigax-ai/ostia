import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { freshDataHome, isolatedLaunch, seedTelemetryAnswered } from './dataHome'
import { emptyState } from './helpers'
import { type ElectronApplication, type Page, _electron as electron, expect, test } from './test'

interface FakePostHog {
  dsn: string
  batches: Array<{ path: string | undefined; apiKey: string | undefined; events: unknown[] }>
  close: () => Promise<void>
}

async function startFakePostHog(): Promise<FakePostHog> {
  const batches: FakePostHog['batches'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const parsed = JSON.parse(body) as { api_key?: string; batch?: unknown[] }
      batches.push({ path: req.url, apiKey: parsed.api_key, events: parsed.batch ?? [] })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    dsn: `http://phc_e2e@127.0.0.1:${(server.address() as AddressInfo).port}`,
    batches,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function launch(
  posthog: FakePostHog,
  dataHome: string,
): Promise<{ app: ElectronApplication; win: Page }> {
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launchOptions,
    env: { ...launchOptions.env, OSTIA_TELEMETRY_URL: posthog.dsn },
  })
  const win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
  await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
  return { app, win }
}

async function crashRenderer(app: ElectronApplication, win: Page): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('diagnostics:test-crash')
  })
  await expect(win.getByRole('heading', { name: 'Something went wrong' })).toBeVisible({
    timeout: 10_000,
  })
  await win.getByRole('button', { name: 'Reload window' }).click()
  await expect(emptyState(win)).toBeVisible({ timeout: 15_000 })
}

test('Don’t share sends nothing, even through a crash and a quit', async () => {
  test.setTimeout(120_000)
  const posthog = await startFakePostHog()
  const dataHome = freshDataHome()
  seedTelemetryAnswered(dataHome, false)
  const { app, win } = await launch(posthog, dataHome)
  try {
    const consent = win.getByTestId('telemetry-consent-dialog')
    await expect(consent).toBeVisible()
    await expect(consent).toContainText('always included with anything you share')
    for (const box of await consent.getByRole('checkbox').all()) await expect(box).not.toBeChecked()
    await expect(consent.getByRole('button', { name: 'Share selected' })).toBeDisabled()
    await crashRenderer(app, win)
    await expect(win.getByTestId('telemetry-consent-dialog')).toBeVisible()
    await win
      .getByTestId('telemetry-consent-dialog')
      .getByRole('button', { name: 'Don’t share' })
      .click()
    await expect(win.getByTestId('telemetry-consent-dialog')).toHaveCount(0)
    await crashRenderer(app, win)
    await win.waitForTimeout(6_000)
  } finally {
    await app.close()
  }
  try {
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    expect(posthog.batches).toEqual([])
  } finally {
    await posthog.close()
  }
})
