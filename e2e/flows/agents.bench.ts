import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DOM_RENDERER_SETTINGS, freshDataHome, HIBERNATE_FAST, seedSettings } from '../dataHome'
import { fakeAgentBin, REPORT_SESSION } from '../fakeAgent'
import { openWorkspace, quitApp, runInTerminal, shownTerminal, typeLine } from '../helpers'
import { expect, type Page, test } from '../test'
import { launchPlain, measure, shownRows } from './flowApp'
import { RUNS, Samples, WARMUP } from './flowResults'

const OSTIA = 'ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "$OSTIA_CLI"'
const SHOWN_ROWS = '.pane-slot:not([data-hidden]) .xterm-rows'
const SETTINGS = { ...DOM_RENDERER_SETTINGS, hibernation: HIBERNATE_FAST }

function resumableAgent(): string {
  return `#!/bin/sh
${REPORT_SESSION}
${OSTIA} state done >/dev/null 2>&1
case "$*" in
  *--resume*) echo fake-agent-resumed ;;
  *) echo fake-agent-ready ;;
esac
exec cat
`
}

function busAgent(takenLog: string): string {
  return `#!/bin/sh
${REPORT_SESSION}
${OSTIA} state done >/dev/null 2>&1
echo fake-agent-ready
while :; do
  ${OSTIA} bus wait --timeout 600 >/dev/null 2>&1
  ${OSTIA} bus inbox --take >/dev/null 2>&1
  date +%s%N >> '${takenLog}'
done
`
}

async function shellMs(win: Page, tag: string, command: string): Promise<number> {
  await typeLine(
    win,
    `clear; s=$(date +%s%N); ${command} >/dev/null 2>&1; e=$(date +%s%N); echo ${tag}-$(( (e-s)/1000000 ))`,
  )
  const done = new RegExp(`${tag}-(\\d+)`)
  await expect(win.locator(SHOWN_ROWS).first()).toContainText(done, { timeout: 60_000 })
  return Number(done.exec((await win.locator(SHOWN_ROWS).first().textContent()) ?? '')?.[1])
}

test('bench agents: resume click and wake to agent ready', async () => {
  test.setTimeout(900_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const bin = fakeAgentBin(dataHome, resumableAgent())
  const { app, win } = await launchPlain(dataHome, { PATH: `${bin}:${process.env.PATH ?? ''}` })
  const samples = new Samples()
  try {
    await openWorkspace(win)
    await runInTerminal(win, 'true', shownTerminal(win))
    const tabs = await win.locator('.pane-tab').count()
    for (let i = 0; i < RUNS + WARMUP; i++) {
      await shellMs(win, `run${i}`, 'ostia agent run claude go --name worker')
      await expect(win.locator('.pane-tab')).toHaveCount(tabs + 1, { timeout: 15_000 })
      await win.locator('.pane-tab').first().click()
      await shellMs(win, `sleep${i}`, 'ostia pane hibernate worker')
      const wake = await shellMs(win, `wake${i}`, 'ostia pane wake worker')
      await shellMs(win, `sleep2${i}`, 'ostia pane hibernate worker')
      await win.locator('.pane-tab').last().click()
      await expect(win.locator('.hibernated-view:visible')).toBeVisible({ timeout: 15_000 })
      const resume = await measure(win, {
        start: { type: 'click', sel: '.hibernated-view' },
        ends: { running: [shownRows('fake-agent-resumed')] },
        act: () => win.locator('.hibernated-view:visible').click(),
      })
      await win.locator('.pane-tab').first().click()
      await shellMs(win, `close${i}`, 'ostia pane close worker')
      await expect(win.locator('.pane-tab')).toHaveCount(tabs, { timeout: 15_000 })
      if (i < WARMUP) continue
      samples.add('agent.wake-ready', wake)
      samples.add('agent.resume-running', resume.running)
    }
  } finally {
    await quitApp(app)
  }
  samples.flush()
})

test('bench agents: bus send to the recipient taking the message', async () => {
  test.setTimeout(600_000)
  const dataHome = freshDataHome()
  seedSettings(dataHome, SETTINGS)
  const takenLog = join(dataHome, 'taken.log')
  const sentLog = join(dataHome, 'sent.log')
  writeFileSync(takenLog, '')
  writeFileSync(sentLog, '')
  const bin = fakeAgentBin(dataHome, busAgent(takenLog))
  const { app, win } = await launchPlain(dataHome, { PATH: `${bin}:${process.env.PATH ?? ''}` })
  try {
    await openWorkspace(win)
    await runInTerminal(win, 'true', shownTerminal(win))
    await shellMs(win, 'run', 'ostia agent run claude go --name worker')
    await win.locator('.pane-tab').first().click()
    for (let i = 0; i < RUNS + WARMUP; i++) {
      await typeLine(
        win,
        `clear; s=$(date +%s%N); ostia bus send worker "m${i}" >/dev/null 2>&1; echo $s >> '${sentLog}'`,
      )
      await expect
        .poll(() => readFileSync(takenLog, 'utf8').split('\n').filter(Boolean).length, {
          timeout: 30_000,
        })
        .toBe(i + 1)
    }
    const sent = readFileSync(sentLog, 'utf8').split('\n').filter(Boolean).map(Number)
    const taken = readFileSync(takenLog, 'utf8').split('\n').filter(Boolean).map(Number)
    const samples = new Samples()
    for (const [i, start] of sent.entries()) {
      if (i >= WARMUP) samples.add('bus.send-taken', (taken[i] - start) / 1e6)
    }
    samples.flush()
  } finally {
    await quitApp(app)
  }
})
