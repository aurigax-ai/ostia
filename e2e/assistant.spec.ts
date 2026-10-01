import { _electron as electron, expect, test } from '@playwright/test'
import { isolatedLaunch } from './dataHome'
import { type FakeRequest, startFakeProvider } from './fakeProvider'
import { PROMPT, openWorkspace } from './helpers'

const SUGGESTED = 'echo pine-assist-suggested'
const ANSWER = 'Use this to list files:\n\n```bash\nls -la\n```\n'

function answer(req: FakeRequest): string {
  if (req.system.includes('"suggestions"')) {
    return JSON.stringify({ suggestions: [{ command: SUGGESTED, description: 'prints a marker' }] })
  }
  return ANSWER
}

test('a custom OpenAI-compatible provider set in Settings answers in Ask and suggests a command that is inserted, not run', async () => {
  const provider = await startFakeProvider(answer)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Assistant', exact: true }).click()
    const assistant = settings.getByRole('group', { name: 'Assistant settings' })
    await assistant.getByRole('combobox', { name: 'Provider' }).click()
    await win.getByRole('option', { name: 'OpenAI-compatible', exact: true }).click()
    for (const [label, value] of [
      ['Base URL', provider.url],
      ['Fast model', 'fake-small'],
      ['Chat model', 'fake-big'],
    ]) {
      const box = assistant.getByRole('textbox', { name: label, exact: true })
      await box.fill(value)
      await box.press('Enter')
    }
    await expect(settings).toContainText('openai-compatible · fake-small / fake-big', {
      timeout: 15_000,
    })
    await win.keyboard.press('Escape')

    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+Shift+P')
    const palette = win.getByRole('dialog')
    await expect(palette).toBeVisible()
    await win.keyboard.type('how do I list files')
    await win.keyboard.press('Tab')
    await win.keyboard.press('Enter')
    const reply = palette.locator('.ask-answer').last()
    await expect(reply).toContainText('Use this to list files', { timeout: 15_000 })
    await expect(reply.locator('pre')).toContainText('ls -la')
    expect(provider.requests.map((r) => r.model)).toContain('fake-big')
    await win.keyboard.press('Escape')
    await expect(palette).toBeHidden()

    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+Shift+J')
    const composer = win.getByRole('region', { name: 'Describe a command' })
    await expect(composer).toBeVisible({ timeout: 5_000 })
    await win.keyboard.type('print a marker')
    const suggestion = composer.getByRole('option', { name: new RegExp(SUGGESTED) })
    await expect(suggestion).toBeVisible({ timeout: 15_000 })
    await win.keyboard.press('Enter')
    await expect(composer).toBeHidden()
    const rows = win.locator('.xterm-rows').first()
    await expect(rows).toContainText(SUGGESTED, { timeout: 10_000 })
    await win.waitForTimeout(500)
    const screen = (await rows.innerText()).split('\n')
    expect(screen.filter((l) => l.trim() === 'pine-assist-suggested')).toHaveLength(0)
    const lines = screen.filter((l) => l.includes(SUGGESTED))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(PROMPT)
    expect(provider.requests.map((r) => r.model)).toContain('fake-small')
  } finally {
    await app.close()
    provider.close()
  }
})
