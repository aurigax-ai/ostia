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

async function openPrivacy(win: Page) {
  await win.locator('.topbar').getByRole('button', { name: 'Settings' }).click()
  const settings = win.getByRole('region', { name: 'Settings' })
  await settings.getByRole('button', { name: 'Privacy' }).click()
  return settings
}

test('nothing is sent before consent, error reports go out after Share, and stop after opting out', async () => {
  test.setTimeout(120_000)
  const posthog = await startFakePostHog()
  const dataHome = freshDataHome()
  seedTelemetryAnswered(dataHome, false)
  const { app, win } = await launch(posthog, dataHome)
  try {
    const consent = win.getByTestId('telemetry-consent-dialog')
    await expect(consent).toBeVisible()
    await expect(consent).toContainText('What is never sent')
    await crashRenderer(app, win)
    await expect(win.getByTestId('telemetry-consent-dialog')).toBeVisible()
    await win.waitForTimeout(6_000)
    expect(posthog.batches).toEqual([])

    await win
      .getByTestId('telemetry-consent-dialog')
      .getByRole('button', { name: 'Share', exact: true })
      .click()
    await expect(win.getByTestId('telemetry-consent-dialog')).toHaveCount(0)
    await crashRenderer(app, win)
    await expect.poll(() => posthog.batches.length, { timeout: 20_000 }).toBe(1)
    expect(posthog.batches[0].path).toBe('/batch/')
    expect(posthog.batches[0].apiKey).toBe('phc_e2e')
    const events = posthog.batches[0].events as Array<Record<string, unknown>>
    const report = events.find((e) => e.event === '$exception') as Record<string, unknown>
    const properties = report.properties as Record<string, unknown>
    expect(properties.source).toBe('render-error')
    expect(properties.$process_person_profile).toBe(false)
    const [exception] = properties.$exception_list as Array<Record<string, unknown>>
    expect(exception.value).toContain('test crash requested by the E2E hook')
    expect(JSON.stringify(report)).not.toContain(dataHome)
    expect(JSON.stringify(report)).not.toContain('/home/')
    expect(report.distinct_id).toMatch(/^[0-9a-f-]{36}$/)

    const settings = await openPrivacy(win)
    await expect(settings.getByRole('switch', { name: 'Error reports' })).toBeChecked()
    await settings.getByRole('switch', { name: 'Error reports' }).click()
    await expect(settings.getByRole('switch', { name: 'Error reports' })).not.toBeChecked()
    await win.keyboard.press('Escape')
    await crashRenderer(app, win)
    await win.waitForTimeout(6_000)
    expect(posthog.batches).toHaveLength(1)
  } finally {
    await app.close()
    await posthog.close()
  }
})

test('usage data is sent once at quit as counts only, and the reports dialog shows it first', async () => {
  test.setTimeout(120_000)
  const posthog = await startFakePostHog()
  const dataHome = freshDataHome()
  seedTelemetryAnswered(dataHome, false)
  const { app, win } = await launch(posthog, dataHome)
  try {
    const consent = win.getByTestId('telemetry-consent-dialog')
    await consent.getByRole('checkbox', { name: /Error reports/ }).click()
    await consent.getByRole('button', { name: 'Share', exact: true }).click()
    await expect(consent).toHaveCount(0)

    const settings = await openPrivacy(win)
    await expect(settings.getByRole('switch', { name: 'Usage data' })).toBeChecked()
    await expect(settings.getByRole('switch', { name: 'Error reports' })).not.toBeChecked()
    await settings.getByRole('button', { name: 'Show what Ostia sends' }).click()
    const reports = win.getByTestId('telemetry-reports-dialog')
    await expect(reports.getByRole('region', { name: 'Waiting to be sent' })).toContainText(
      'Nothing.',
    )
    await win.keyboard.press('Escape')
    await expect(reports).toHaveCount(0)
  } finally {
    await app.close()
  }
  try {
    await expect.poll(() => posthog.batches.length, { timeout: 10_000 }).toBe(1)
    const events = posthog.batches[0].events as Array<Record<string, unknown>>
    expect(events).toHaveLength(1)
    expect(events[0].event).toBe('usage')
    const properties = events[0].properties as Record<string, Record<string, number>>
    expect(properties.settings).toEqual({ appearance: 1, privacy: 1 })
    expect(properties.surfaces).toEqual({})
    expect(JSON.stringify(events[0])).not.toContain(dataHome)
  } finally {
    await posthog.close()
  }
})
