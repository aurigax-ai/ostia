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

const allEvents = (posthog: FakePostHog) =>
  posthog.batches.flatMap((b) => b.events) as Array<{
    event: string
    distinct_id: string
    properties: Record<string, unknown>
  }>

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

test('sharing only errors sends an exception and a usage event without other categories, and off stops it', async () => {
  test.setTimeout(150_000)
  const posthog = await startFakePostHog()
  const dataHome = freshDataHome()
  seedTelemetryAnswered(dataHome, false)
  let { app, win } = await launch(posthog, dataHome)
  try {
    const consent = win.getByTestId('telemetry-consent-dialog')
    await consent.getByRole('checkbox', { name: /Crash and error reports/ }).click()
    await consent.getByRole('button', { name: 'Share selected', exact: true }).click()
    await expect(consent).toHaveCount(0)
    await crashRenderer(app, win)
    await expect.poll(() => posthog.batches.length, { timeout: 20_000 }).toBe(1)
    expect(posthog.batches[0].path).toBe('/batch/')
    expect(posthog.batches[0].apiKey).toBe('phc_e2e')
    const report = allEvents(posthog).find((e) => e.event === '$exception')
    expect(report).toBeDefined()
    expect(report?.properties.source).toBe('render-error')
    expect(report?.properties.$process_person_profile).toBe(false)
    expect(report?.properties.channel).toBe('source')
    const [exception] = report?.properties.$exception_list as Array<Record<string, unknown>>
    expect(exception.value).toContain('test crash requested by the E2E hook')
    expect(JSON.stringify(report)).not.toContain(dataHome)
    expect(JSON.stringify(report)).not.toContain('/home/')
    expect(report?.distinct_id).toMatch(/^[0-9a-f-]{36}$/)

    const settings = await openPrivacy(win)
    await expect(settings.getByRole('switch', { name: 'Crash and error reports' })).toBeChecked()
    await expect(settings.getByRole('switch', { name: 'App usage' })).not.toBeChecked()
    await settings.getByRole('button', { name: 'Show what Ostia sends' }).click()
    const reports = win.getByTestId('telemetry-reports-dialog')
    await expect(reports.getByRole('region', { name: 'Last sent' })).toContainText('$exception')
    await win.keyboard.press('Escape')
    await expect(reports).toHaveCount(0)
  } finally {
    await app.close()
  }
  await expect
    .poll(() => allEvents(posthog).filter((e) => e.event === 'usage').length, {
      timeout: 10_000,
    })
    .toBe(0)
  ;({ app, win } = await launch(posthog, dataHome))
  try {
    await expect(win.getByTestId('telemetry-consent-dialog')).toHaveCount(0)
    const settings = await openPrivacy(win)
    await settings.getByRole('switch', { name: 'App usage' }).click()
    await expect(settings.getByRole('switch', { name: 'App usage' })).toBeChecked()
    await win.keyboard.press('Escape')
  } finally {
    await app.close()
  }
  try {
    await expect
      .poll(() => allEvents(posthog).filter((e) => e.event === 'usage').length, { timeout: 10_000 })
      .toBe(1)
    const usage = allEvents(posthog).find((e) => e.event === 'usage')
    const keys = Object.keys(usage?.properties ?? {})
    expect(usage?.properties['usage.app_starts']).toBe(1)
    expect(keys.some((k) => k.startsWith('features.'))).toBe(false)
    expect(keys.some((k) => k.startsWith('agents.'))).toBe(false)
    expect(keys.some((k) => k.startsWith('terminal.'))).toBe(false)
    expect(JSON.stringify(usage)).not.toContain(dataHome)
  } finally {
    await posthog.close()
  }
})

test('turning errors off afterwards sends nothing more', async () => {
  test.setTimeout(120_000)
  const posthog = await startFakePostHog()
  const dataHome = freshDataHome()
  seedTelemetryAnswered(dataHome, false)
  const { app, win } = await launch(posthog, dataHome)
  try {
    const consent = win.getByTestId('telemetry-consent-dialog')
    await consent.getByRole('checkbox', { name: /Crash and error reports/ }).click()
    await consent.getByRole('button', { name: 'Share selected', exact: true }).click()
    await expect(consent).toHaveCount(0)
    const settings = await openPrivacy(win)
    await settings.getByRole('switch', { name: 'Crash and error reports' }).click()
    await expect(
      settings.getByRole('switch', { name: 'Crash and error reports' }),
    ).not.toBeChecked()
    await win.keyboard.press('Escape')
    await crashRenderer(app, win)
    await win.waitForTimeout(6_000)
    expect(posthog.batches).toEqual([])
  } finally {
    await app.close()
    await posthog.close()
  }
})
