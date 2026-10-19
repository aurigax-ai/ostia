import { chords } from './chords'
import { freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { type FakeRequest, fakeAssistantSettings, startFakeProvider } from './fakeProvider'
import { PROMPT, expectHeld, openWorkspace } from './helpers'
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

test('an Ask answer fits its inline command chip to the code, and a suggested command is inserted at the shell prompt, not run', async () => {
  const provider = await startFakeProvider(answer)
  const dataHome = freshDataHome()
  seedSettings(dataHome, { assistant: fakeAssistantSettings(provider.url) })
  const app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)

    await win.locator('.xterm').first().click()
    await win.keyboard.press(chords.palette)
    const palette = win.getByRole('dialog')
    await expect(palette).toBeVisible()
    await win.keyboard.type('how do I list files')
    await win.keyboard.press('Tab')
    const question = palette.getByRole('combobox', { name: 'Your question' })
    await expect(question).toBeFocused()
    await expect(question).toHaveValue('how do I list files')
    await win.keyboard.press('Enter')
    const reply = palette.locator('.ask-answer').last()
    await expect(reply).toContainText('Use this to list files', { timeout: 15_000 })
    await expect(reply.locator('pre')).toContainText('ls -la')
    const chip = reply.locator('.chat-inline-command')
    const chipBox = await chip.boundingBox()
    const codeBox = await chip.locator('code').boundingBox()
    expect(chipBox && codeBox && chipBox.width - codeBox.width).toBeLessThan(1)
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
    await win.locator('.xterm').first().click()
    await win.keyboard.press('Control+C')
    await expect
      .poll(async () => (await rows.innerText()).split('\n').filter((l) => l.includes('❯')).length)
      .toBe(2)
    const typed = async (): Promise<{ ran: number; typed: number }> => {
      const screen = (await rows.innerText()).split('\n')
      return {
        ran: screen.filter((l) => l.trim() === 'ostia-assist-suggested').length,
        typed: screen.filter((l) => l.includes(SUGGESTED)).length,
      }
    }
    await expectHeld(typed, { ran: 0, typed: 1 }, 1_500)
    const lines = (await rows.innerText()).split('\n').filter((l) => l.includes(SUGGESTED))
    expect(lines[0]).toMatch(PROMPT)
  } finally {
    await app.close()
    provider.close()
  }
})
