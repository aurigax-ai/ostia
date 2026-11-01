import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { type IncidentScenario, scenarioOf } from '../../test/incidentScenario'
import {
  CANVAS_RENDERER_SETTINGS,
  freshDataHome,
  isolatedLaunch,
  seedSettings,
  testHome,
} from '../dataHome'
import { fakeAgentBin, isolatedHome } from '../fakeAgent'
import { openWorkspace, PROMPT, typeLine } from '../helpers'
import { _electron as electron, expect, type Page, test } from '../test'

const AGENT = resolve(__dirname, '../../test/fixtures/tools/bin/incident-agent/agent.mjs')

const REPLAY_NOTE =
  'This replays Ostia side only: its calls, timings and pane states against a fake agent. It cannot replay what a real agent did inside.'

const LINES: Record<IncidentScenario['replay'], (dataHome: string) => string> = {
  'send-enter': () =>
    "printf 'line one\\nline two' | ostia pane send worker - --enter; echo step-exit-$?",
  wait: () => 'ostia pane wait worker --until done --timeout 40 & echo step-exit-0',
  wake: () => 'ostia pane wake worker --timeout 12; echo step-exit-$?',
  mail: () => 'ostia bus send worker "please review"; echo step-exit-$?',
  'run-outside': (dataHome) =>
    `ostia agent run claude hi --cwd '${join(dataHome, 'elsewhere')}'; echo step-exit-$?`,
}

function seedProject(dataHome: string): void {
  const project = join(testHome(dataHome), 'work', 'shop')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(dataHome, 'ostia'), { recursive: true })
  writeFileSync(
    join(dataHome, 'ostia', 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: 's1',
      groups: [],
      workspaces: [
        {
          id: 's1',
          name: 'shop',
          kind: 'terminal',
          workDir: project,
          root: { type: 'pane', id: 'pane-1', title: 'shell', kind: 'terminal', cwd: project },
          activePaneId: 'pane-1',
        },
      ],
    }),
  )
}

async function waitForProject(win: Page): Promise<void> {
  await expect(win.locator('.terminal-text').first()).toContainText(PROMPT, { timeout: 20_000 })
}

test('replays an incident report against the built app', async () => {
  test.setTimeout(240_000)
  const file = process.env.OSTIA_REPRO_INCIDENT
  const resultFile = process.env.OSTIA_REPRO_RESULT
  expect(file, 'OSTIA_REPRO_INCIDENT names the report file').toBeTruthy()
  const parsed = scenarioOf(readFileSync(file as string, 'utf8'))
  const write = (result: object): void => {
    if (resultFile) writeFileSync(resultFile, JSON.stringify({ note: REPLAY_NOTE, ...result }))
  }
  if (!parsed.ok) {
    write({ verdict: 'unsupported', reason: parsed.reason })
    return
  }
  const { scenario } = parsed
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...CANVAS_RENDERER_SETTINGS,
    agents: {
      trustWorkspaceFolders: true,
      ...(scenario.hooksOff ? { hooks: { claude: false } } : {}),
    },
  })
  mkdirSync(join(dataHome, 'elsewhere'), { recursive: true })
  if (scenario.replay === 'run-outside') seedProject(dataHome)
  const configDir = join(dataHome, 'claude-config')
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, '.claude.json'), JSON.stringify({ userID: 'e2e', projects: {} }))
  const bin = fakeAgentBin(
    dataHome,
    `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 "$OSTIA_NODE" "${AGENT}"\n`,
  )
  const launch = isolatedLaunch(dataHome)
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      HOME: isolatedHome(dataHome),
      PATH: `${bin}:${launch.env.PATH ?? ''}`,
      CLAUDE_CONFIG_DIR: configDir,
      REPRO_MARKER: join(dataHome, 'agent-started'),
      REPRO_SWALLOW_ENTER: scenario.swallowEnter ? '1' : '0',
      REPRO_NEVER_DONE: scenario.neverDone ? '1' : '0',
      REPRO_SILENT_WAKE: scenario.silentWake ? '1' : '0',
    },
  })
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    if (scenario.replay === 'run-outside') await waitForProject(win)
    else await openWorkspace(win)
    const caller = win.locator('.terminal-text').first()
    await win.locator('.ghostty-host').first().click()
    await typeLine(win, 'ostia agent run claude go --name worker; echo run-exit-$?')
    await expect(caller).toContainText('run-exit-0', { timeout: 30_000 })
    if (scenario.draft) {
      await typeLine(win, 'ostia pane send worker "a draft"; echo draft-exit-$?')
      await expect(caller).toContainText('draft-exit-0', { timeout: 15_000 })
    }
    if (scenario.replay === 'wake') {
      await typeLine(
        win,
        'ostia pane wait worker --until done --timeout 20; ostia pane hibernate worker; echo hib-exit-$?',
      )
      await expect(caller).toContainText('hib-exit-', { timeout: 40_000 })
      await typeLine(win, 'clear; ostia pane status worker')
      await expect(caller).toContainText('hibernated', { timeout: 20_000 })
    }
    await typeLine(win, LINES[scenario.replay](dataHome))
    await expect(caller).toContainText('step-exit-', { timeout: 60_000 })
    const observed = new Set<string>()
    const hit = () => scenario.accept.some((code) => observed.has(code))
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !hit()) {
      const list = await win.evaluate(() => window.ostia.incidents.list('24h'))
      for (const item of list) observed.add(item.trigger)
      if (!hit()) await win.waitForTimeout(1000)
    }
    write({
      verdict: hit() ? 'reproduced' : 'not-reproduced',
      expected: scenario.accept.join(' or '),
      observed: [...observed],
      ...(hit() ? {} : { screen: (await caller.innerText()).slice(-1500) }),
    })
  } finally {
    await app.close()
  }
})
