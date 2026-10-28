import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chords } from '../chords'
import { DOM_RENDERER_SETTINGS, freshDataHome, seedSettings } from '../dataHome'
import { startFakeProvider } from '../fakeProvider'
import { openWorkspace, quitApp } from '../helpers'
import { expect, test } from '../test'
import { launchPlain, measure } from './flowApp'
import { RUNS, Samples, WARMUP } from './flowResults'

test('bench agent pane: prompt to first streamed token', async () => {
  test.setTimeout(600_000)
  const provider = await startFakeProvider(() => 'tokenfirst answer streamed by the fake provider')
  const dataHome = freshDataHome()
  const project = join(dataHome, 'userData', 'project')
  mkdirSync(project, { recursive: true })
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    workspaces: { confirmQuit: false, defaultFolder: project },
    agent: {
      providers: [{ id: 'fake', name: 'Fake', baseUrl: provider.url, models: ['fake-model'] }],
    },
  })
  const { app, win } = await launchPlain(dataHome)
  const samples = new Samples()
  try {
    await openWorkspace(win)
    await win.keyboard.press(chords.palette)
    await win.keyboard.type('Agent: Open pane')
    await win.getByRole('option', { name: /Agent: Open pane/ }).click()
    const question = win.getByRole('textbox', { name: 'Your question' }).last()
    await expect(question).toBeVisible({ timeout: 15_000 })
    for (let i = 0; i < RUNS + WARMUP; i++) {
      await question.fill(`question ${i}`)
      const got = await measure(win, {
        start: { type: 'keydown', key: 'enter' },
        ends: { token: [{ sel: '.ask-answer.chat-message', text: 'tokenfirst', min: i + 1 }] },
        act: () => question.press('Enter'),
      })
      await expect(win.locator('.ask-answer.chat-message[aria-busy="true"]')).toHaveCount(0, {
        timeout: 30_000,
      })
      if (i < WARMUP) continue
      samples.add('agent-pane.first-token', got.token)
    }
  } finally {
    await quitApp(app)
    await provider.close()
  }
  samples.flush()
})
