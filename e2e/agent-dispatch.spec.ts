import { chords } from './chords'
import { CANVAS_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { fakeAgentBin, isolatedHome } from './fakeAgent'
import { type FakeReply, type FakeRequest, startFakeProvider } from './fakeProvider'
import { openWorkspace, typeLine } from './helpers'
import { _electron as electron, expect, test } from './test'

function answer(request: FakeRequest, seen: number): FakeReply {
  if (seen === 0) return { toolCalls: [{ name: 'ostia_panes', args: {} }] }
  if (seen === 1) {
    return {
      toolCalls: [
        { name: 'ostia_agent_run', args: { agent: 'claude', prompt: 'go', name: 'worker' } },
      ],
    }
  }
  if (seen === 2) {
    const started = JSON.parse(request.toolResult ?? '{}') as { paneId?: string }
    return {
      toolCalls: [
        { name: 'ostia_bus_send', args: { to: started.paneId ?? '', text: 'review-42-done' } },
      ],
    }
  }
  if (seen === 3) return { toolCalls: [{ name: 'ostia_managed', args: {} }] }
  return 'dispatch-finished'
}

test('pi lists panes, starts an agent after a card, messages it over the bus without typing, and lists it as managed', async () => {
  test.setTimeout(180_000)
  let seen = 0
  const provider = await startFakeProvider((request) => answer(request, seen++))
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...CANVAS_RENDERER_SETTINGS,
    agent: {
      providers: [{ id: 'fake', name: 'Fake', baseUrl: provider.url, models: ['fake-model'] }],
    },
  })
  const bin = fakeAgentBin(dataHome)
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: { ...launch.env, HOME: isolatedHome(dataHome), PATH: `${bin}:${launch.env.PATH ?? ''}` },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.keyboard.press(chords.palette)
    await win.keyboard.type('Agent: Open pane')
    await win.getByRole('option', { name: /Agent: Open pane/ }).click()
    const question = win.getByRole('textbox', { name: 'Your question' }).last()
    await expect(question).toBeVisible({ timeout: 15_000 })
    await question.fill('start a worker and tell it the review is done')
    await question.press('Enter')

    await expect(win.getByText('Allow the Agent to start an agent?')).toBeVisible({
      timeout: 30_000,
    })
    await win.getByRole('button', { name: 'Allow once' }).click()

    await expect(win.getByText('Allow the Agent to send a message to another agent?')).toBeVisible({
      timeout: 60_000,
    })
    await win.getByRole('button', { name: 'Allow once' }).click()

    await expect(win.getByText('dispatch-finished')).toBeVisible({ timeout: 60_000 })

    expect(provider.requests[0].tools).toContain('ostia_agent_run')
    expect(provider.requests[1].toolResult).toContain('"kind"')
    expect(provider.requests[2].toolResult).toMatch(/"paneId":"[0-9a-f-]{36}"/)
    expect(provider.requests[3].toolResult).toContain('"state":"queued"')
    const managed = JSON.parse(provider.requests[4].toolResult ?? '{}') as {
      managed: { name: string; agent: string }[]
    }
    expect(managed.managed).toHaveLength(1)
    expect(managed.managed[0]).toMatchObject({ name: 'worker', agent: 'claude' })

    await expect(
      win.getByRole('img', { name: '1 unread message for this agent' }).first(),
    ).toBeVisible({
      timeout: 15_000,
    })
    const caller = win.locator('.terminal-text').first()
    await win.locator('.ghostty-host').first().click()
    await typeLine(win, 'clear; ostia pane read worker; echo read-done')
    await win.getByRole('button', { name: 'Allow once' }).click()
    await expect(caller).toContainText('read-done', { timeout: 20_000 })
    await expect(caller).toContainText('fake-agent-ready')
    await expect(caller).not.toContainText('review-42-done')
  } finally {
    await app.close()
    provider.close()
  }
})
