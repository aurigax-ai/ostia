import { isolatedLaunch } from './dataHome'
import { extensionHosts } from './extensionHosts'
import { type FakeRequest, startFakeProvider } from './fakeProvider'
import { PROMPT, openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

const SUGGESTED = 'echo ostia-assist-suggested'
const SECOND = 'echo ostia-assist-second'
const ANSWER = 'Use this to list files:\n\n```bash\nls -la\n```\n\nOr run `ls -la` here.\n'

function answer(req: FakeRequest): string {
  if (req.system.includes('"suggestions"')) {
    return JSON.stringify({
      suggestions: [
        { command: SUGGESTED, description: 'prints a marker' },
        { command: SECOND, description: 'prints another marker' },
      ],
    })
  }
  return ANSWER
}

test('an OpenAI-compatible provider added in Settings with two models answers in Ask with the chat model and suggests a command with the fast one, inserted, not run', async () => {
  const provider = await startFakeProvider(answer)
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    expect(extensionHosts(app)).not.toContain('assistant')

    await win.keyboard.press('Control+,')
    const settings = win.getByRole('region', { name: 'Settings' })
    await expect(settings).toBeVisible({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Assistant', exact: true }).click()
    await expect(
      settings.getByText('Add a provider and a model first. Nothing is sent until then.'),
    ).toBeVisible({ timeout: 15_000 })
    await expect.poll(() => extensionHosts(app), { timeout: 15_000 }).toContain('assistant')
    await settings.getByRole('button', { name: 'Add provider' }).click()
    await win.getByRole('menuitem', { name: 'OpenAI-compatible', exact: true }).click()
    const card = settings.getByRole('listitem', { name: 'OpenAI-compatible' })
    await expect(card.getByRole('status')).toHaveText('Needs a base URL', { timeout: 15_000 })
    const url = card.getByRole('textbox', { name: 'Base URL: OpenAI-compatible' })
    await url.fill(provider.url)
    await url.press('Enter')
    await expect(card.getByRole('status')).toHaveText('No models yet', { timeout: 15_000 })
    const addModel = card.getByRole('combobox', { name: 'Model id for OpenAI-compatible' })
    await addModel.click()
    await win.getByRole('option', { name: 'fake-small', exact: true }).click()
    await expect(card.getByRole('status')).toHaveText('Ready', { timeout: 15_000 })
    await addModel.fill('fake-big')
    await win.getByRole('option', { name: 'fake-big', exact: true }).click()
    await expect(card.getByRole('list', { name: 'Models: OpenAI-compatible' })).toContainText(
      'fake-big',
    )
    const fast = settings.getByRole('combobox', { name: 'Fast model' })
    const chat = settings.getByRole('combobox', { name: 'Chat model' })
    await expect(fast).toContainText('OpenAI-compatible · fake-small', { timeout: 15_000 })
    await expect(chat).toContainText('OpenAI-compatible · fake-small')
    await chat.click()
    await win.getByRole('option', { name: 'fake-big', exact: true }).click()
    await expect(chat).toContainText('OpenAI-compatible · fake-big', { timeout: 15_000 })
    await expect(settings.locator('[data-feature="chat"]')).toContainText(
      'Uses OpenAI-compatible · fake-big',
    )
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
    const chip = reply.locator('.chat-inline-command')
    const chipBox = await chip.boundingBox()
    const codeBox = await chip.locator('code').boundingBox()
    expect(chipBox && codeBox && chipBox.width - codeBox.width).toBeLessThan(1)
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
    await expect(suggestion).toHaveAttribute('aria-selected', 'true')
    const second = composer.getByRole('option', { name: new RegExp(SECOND) })
    const background = (el: Element) => getComputedStyle(el).backgroundColor
    expect(await suggestion.evaluate(background)).not.toBe(await second.evaluate(background))
    expect(await suggestion.evaluate(background)).not.toBe(await composer.evaluate(background))
    await win.keyboard.press('Enter')
    await expect(composer).toBeHidden()
    const rows = win.locator('.xterm-rows').first()
    await expect(rows).toContainText(SUGGESTED, { timeout: 10_000 })
    await win.waitForTimeout(500)
    const screen = (await rows.innerText()).split('\n')
    expect(screen.filter((l) => l.trim() === 'ostia-assist-suggested')).toHaveLength(0)
    const lines = screen.filter((l) => l.includes(SUGGESTED))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(PROMPT)
    expect(provider.requests.map((r) => r.model)).toContain('fake-small')
  } finally {
    await app.close()
    provider.close()
  }
})
