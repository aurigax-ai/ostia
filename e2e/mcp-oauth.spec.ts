import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { _electron as electron, expect, test } from './test'
import { type FakeMcpHttp, startFakeMcpHttp } from '../test/fixtures/mcp/startHttpServer'
import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { type FakeProvider, fakeAssistantSettings, startFakeProvider } from './fakeProvider'
import { openWorkspace } from './helpers'

function findFile(dir: string, name: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isFile() && entry.name === name) return path
    if (entry.isDirectory()) {
      const found = findFile(path, name)
      if (found) return found
    }
  }
  return null
}

test.describe('OAuth sign-in for a URL MCP server', () => {
  let provider: FakeProvider
  let mcp: FakeMcpHttp

  test.beforeAll(async () => {
    provider = await startFakeProvider(() => 'Hello from the fake model.')
    mcp = await startFakeMcpHttp({ oauth: true })
  })

  test.afterAll(() => {
    provider.close()
    mcp.close()
  })

  test('the human adds the server in Settings, signs in, tests it, and a chat lists its tools', async () => {
    test.setTimeout(120_000)
    const dataHome = freshDataHome()
    seedSettings(dataHome, {
      ...DOM_RENDERER_SETTINGS,
      assistant: fakeAssistantSettings(provider.url),
    })
    const options = isolatedLaunch(dataHome)
    const app = await electron.launch({
      ...options,
      args: ['--password-store=basic', ...options.args],
      env: { ...options.env, OSTIA_MCP_OAUTH_BROWSER: 'fetch' },
    })
    try {
      const win = await app.firstWindow()
      await app.evaluate(({ safeStorage }) => safeStorage.setUsePlainTextEncryption(true))
      await win.waitForLoadState('domcontentloaded')
      await openWorkspace(win)

      await win.keyboard.press('Control+,')
      const settings = win.getByRole('region', { name: 'Settings' })
      await expect(settings).toBeVisible({ timeout: 10_000 })
      await settings.getByRole('button', { name: 'Assistant', exact: true }).click()
      await settings.getByRole('button', { name: 'Add server' }).click()
      const dialog = win.getByRole('dialog', { name: 'Add MCP server' })
      await dialog.getByLabel('Name').fill('fake')
      await dialog.getByRole('combobox', { name: 'Type' }).click()
      await win.getByRole('option', { name: 'URL' }).click()
      await dialog.getByLabel('URL').fill(mcp.url)
      await dialog.getByRole('button', { name: 'Add server' }).click()

      const row = settings.locator('[data-mcp="fake"]')
      await expect(row).toContainText('Sign-in required', { timeout: 15_000 })
      expect(await mcp.stats()).toMatchObject({ registrations: 0, authorizations: 0 })

      await row.getByRole('button', { name: 'Test fake' }).click()
      await expect(row.getByText(/^Test failed: .*401/)).toBeVisible({ timeout: 15_000 })

      await row.getByRole('button', { name: 'Sign in to fake' }).click()
      await expect(row).toContainText('Signed in', { timeout: 15_000 })
      await expect(row).toContainText('Connected · 5 tools', { timeout: 15_000 })
      await expect(row.getByRole('button', { name: 'Sign in to fake' })).toHaveCount(0)
      expect(await mcp.stats()).toMatchObject({ registrations: 1, authorizations: 1, exchanges: 1 })

      await row.getByRole('button', { name: 'Test fake' }).click()
      await expect(row.getByText('Test passed · 5 tools')).toBeVisible({ timeout: 15_000 })

      const secretsFile = findFile(dataHome, 'mcp-secrets.json')
      expect(secretsFile).not.toBeNull()
      const secrets = JSON.parse(readFileSync(secretsFile as string, 'utf8'))
      expect(Object.keys(secrets.fake)).toEqual(['oauth:session'])
      expect(JSON.stringify(secrets)).not.toContain('access_token')
      const settingsFile = join(dataHome, 'userData', 'settings.json')
      await expect
        .poll(() => existsSync(settingsFile) && readFileSync(settingsFile, 'utf8'))
        .toContain(mcp.url)
      expect(readFileSync(settingsFile, 'utf8')).not.toMatch(/oauth|token|client-/i)

      await win.keyboard.press('Escape')
      await win
        .locator('header.topbar')
        .getByRole('button', { name: /^Open chat/ })
        .click()
      await expect(win.getByRole('combobox', { name: 'Your question' }).last()).toBeVisible({
        timeout: 10_000,
      })
      await win.getByRole('button', { name: 'Tools for this chat' }).click()
      const tools = win.getByRole('dialog', { name: 'Tools for this chat' })
      await expect(tools).toContainText('fake', { timeout: 15_000 })
      await expect(tools.getByText('5 tools')).toBeVisible({ timeout: 15_000 })
      await win.keyboard.press('Escape')

      await win.keyboard.press('Control+,')
      await settings.getByRole('button', { name: 'Assistant', exact: true }).click()
      await row.getByRole('button', { name: 'Sign out of fake' }).click()
      await expect(row).toContainText('Sign-in required', { timeout: 15_000 })
      await expect.poll(() => JSON.parse(readFileSync(secretsFile as string, 'utf8'))).toEqual({})
    } finally {
      await app.close()
    }
  })
})
