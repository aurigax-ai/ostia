import { freshDataHome, seedSettings } from '../dataHome'
import { fakeAgentBin, REPORT_SESSION } from '../fakeAgent'
import { openWorkspace, quitApp, runInTerminal, shownTerminal, typeLine } from '../helpers'
import { expect, type Page, test } from '../test'
import { launchPlain } from './flowApp'
import { RUNS, Samples, WARMUP } from './flowResults'

const SHOWN_ROWS = '.pane-slot:not([data-hidden]) .terminal-text'
const TURN_AGENT = `#!/bin/sh
${REPORT_SESSION}
ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI" state done >/dev/null 2>&1
echo fake-agent-ready
exec cat
`
const SETTINGS = { behavior: { gpuAcceleration: false }, workspaces: { confirmQuit: false } }

async function timedCli(win: Page, tag: string, command: string): Promise<number> {
  await typeLine(
    win,
    `clear; s=$(date +%s%N); ${command} >/dev/null 2>&1; e=$(date +%s%N); echo ${tag}-$(( (e-s)/1000000 ))`,
  )
  const done = new RegExp(`${tag}-(\\d+)`)
  await expect(win.locator(SHOWN_ROWS).first()).toContainText(done, { timeout: 30_000 })
  return Number(done.exec((await win.locator(SHOWN_ROWS).first().textContent()) ?? '')?.[1])
}

test('bench cli: round trip, agent run and pane send', async () => {
  test.setTimeout(600_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const bin = fakeAgentBin(dataHome, TURN_AGENT)
  const { app, win } = await launchPlain(dataHome, { PATH: `${bin}:${process.env.PATH ?? ''}` })
  const samples = new Samples()
  try {
    await openWorkspace(win)
    await runInTerminal(win, 'true', shownTerminal(win))
    const caller = await win.locator('.pane-tab').count()
    for (let i = 0; i < RUNS + WARMUP; i++) {
      const trip = await timedCli(win, `rt${i}`, 'ostia pane list')
      const run = await timedCli(win, `run${i}`, `ostia agent run claude go --name w${i}`)
      await expect(win.locator('.pane-tab')).toHaveCount(caller + 1, { timeout: 15_000 })
      const send = await timedCli(win, `send${i}`, `ostia pane send w${i} hello`)
      await timedCli(win, `close${i}`, `ostia pane close w${i}`)
      await expect(win.locator('.pane-tab')).toHaveCount(caller, { timeout: 15_000 })
      await shownTerminal(win).click()
      if (i < WARMUP) continue
      samples.add('cli.round-trip', trip)
      samples.add('cli.agent-run', run)
      samples.add('cli.pane-send', send)
    }
  } finally {
    await quitApp(app)
  }
  samples.flush()
})
