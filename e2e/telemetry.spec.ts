import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  type ElectronApplication,
  type Page,
  _electron as electron,
  expect,
  test,
} from './test'
import { freshDataHome, isolatedLaunch, seedTelemetryAnswered } from './dataHome'
import { emptyState } from './helpers'

interface FakeGlitchTip {
  dsn: string
  envelopes: Array<{ path: string | undefined; auth: string | undefined; events: unknown[] }>
  close: () => Promise<void>
}

function eventsOf(body: string): unknown[] {
  return body
    .split('\n')
    .filter((line, i) => i > 0 && i % 2 === 0 && line)
    .map((line) => JSON.parse(line))
}

async function startFakeGlitchTip(): Promise<FakeGlitchTip> {
  const envelopes: FakeGlitchTip['envelopes'] = []
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      envelopes.push({
        path: req.url,
        auth: req.headers['x-sentry-auth'] as string | undefined,
        events: eventsOf(body),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    dsn: `http://e2e@127.0.0.1:${(server.address() as AddressInfo).port}/5`,
    envelopes,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

async function launch(
  glitchtip: FakeGlitchTip,
  dataHome: string,
): Promise<{ app: ElectronApplication; win: Page }> {
  const launchOptions = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launchOptions,
    env: { ...launchOptions.env, OSTIA_TELEMETRY_URL: glitchtip.dsn },
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
  const glitchtip = await startFakeGlitchTip()
  const dataHome = freshDataHome()
  seedTelemetryAnswered(dataHome, false)
  const { app, win } = await launch(glitchtip, dataHome)
  try {
    const consent = win.getByTestId('telemetry-consent-dialog')
    await expect(consent).toBeVisible()
    await expect(consent).toContainText('What is never sent')
    await crashRenderer(app, win)
    await expect(win.getByTestId('telemetry-consent-dialog')).toBeVisible()
    await win.waitForTimeout(6_000)
    expect(glitchtip.envelopes).toEqual([])

    await win.getByTestId('telemetry-consent-dialog').getByRole('button', { name: 'Share', exact: true }).click()
    await expect(win.getByTestId('telemetry-consent-dialog')).toHaveCount(0)
    await crashRenderer(app, win)
    await expect.poll(() => glitchtip.envelopes.length, { timeout: 20_000 }).toBe(1)
    expect(glitchtip.envelopes[0].path).toBe('/api/5/envelope/')
    expect(glitchtip.envelopes[0].auth).toContain('sentry_key=e2e')
    const events = glitchtip.envelopes[0].events as Array<Record<string, unknown>>
    const report = events.find((e) => e.level === 'error') as Record<string, unknown>
    expect(report.tags).toEqual({ source: 'render-error' })
    const exception = (report.exception as { values: Array<Record<string, unknown>> }).values[0]
    expect(exception.value).toContain('test crash requested by the E2E hook')
    expect(JSON.stringify(report)).not.toContain(dataHome)
    expect(JSON.stringify(report)).not.toContain('/home/')
    expect(report.user).toEqual({ id: expect.stringMatching(/^[0-9a-f-]{36}$/) })

    const settings = await openPrivacy(win)
    await expect(settings.getByRole('switch', { name: 'Error reports' })).toBeChecked()
    await settings.getByRole('switch', { name: 'Error reports' }).click()
    await expect(settings.getByRole('switch', { name: 'Error reports' })).not.toBeChecked()
    await win.keyboard.press('Escape')
    await crashRenderer(app, win)
    await win.waitForTimeout(6_000)
    expect(glitchtip.envelopes).toHaveLength(1)
  } finally {
    await app.close()
    await glitchtip.close()
  }
})

test('usage data is sent once at quit as counts only, and the reports dialog shows it first', async () => {
  test.setTimeout(120_000)
  const glitchtip = await startFakeGlitchTip()
  const dataHome = freshDataHome()
  seedTelemetryAnswered(dataHome, false)
  const { app, win } = await launch(glitchtip, dataHome)
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
    await expect.poll(() => glitchtip.envelopes.length, { timeout: 10_000 }).toBe(1)
    const events = glitchtip.envelopes[0].events as Array<Record<string, unknown>>
    expect(events).toHaveLength(1)
    expect(events[0].level).toBe('info')
    expect(events[0].message).toBe('usage')
    const extra = events[0].extra as Record<string, Record<string, number>>
    expect(extra.settings).toEqual({ appearance: 1, privacy: 1 })
    expect(extra.surfaces).toEqual({})
    expect(JSON.stringify(events[0])).not.toContain(dataHome)
  } finally {
    await glitchtip.close()
  }
})
