import { copyFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chords } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { installApproved, panelEval, waitForPaletteSelection } from './helpers'
import { _electron as electron, expect, test } from './test'

const FIXTURES = resolve(__dirname, '../test/fixtures/tools')

test('the Trellis panel filters, edits cards, keeps focus and closes in Escape order', async () => {
  test.setTimeout(120_000)
  const dataHome = freshDataHome()
  const launch = isolatedLaunch(dataHome)
  const project = join(launch.home, 'shop')
  const trellisDir = join(dataHome, 'fake-trellis')
  for (const d of [project, trellisDir]) mkdirSync(d, { recursive: true })
  writeFileSync(join(project, '.trellis'), '/DEMO\n')
  for (const f of readdirSync(join(FIXTURES, 'trellis'))) {
    copyFileSync(join(FIXTURES, 'trellis', f), join(trellisDir, f))
  }
  mkdirSync(join(dataHome, 'ostia'), { recursive: true })
  writeFileSync(
    join(dataHome, 'ostia', 'workspaces.json'),
    JSON.stringify({
      v: 1,
      savedAt: new Date().toISOString(),
      activeWorkspaceId: 's1',
      workspaces: [
        {
          id: 's1',
          name: 'shop',
          kind: 'terminal',
          workDir: project,
          activePaneId: 'pane-1',
          root: { type: 'pane', id: 'pane-1', title: 'zsh', kind: 'terminal', cwd: project },
        },
      ],
    }),
  )
  installApproved(dataHome, launch.env.XDG_CONFIG_HOME, 'trellis')
  const app = await electron.launch({
    ...launch,
    env: {
      ...launch.env,
      PATH: `${join(FIXTURES, 'bin')}:${process.env.PATH}`,
      FAKE_TRELLIS_DIR: trellisDir,
    },
  })
  const panel = (script: string): Promise<string> => panelEval(app, script)
  const click = (selector: string): Promise<string> =>
    panel(`document.querySelector('${selector}').click(); 'ok'`)
  const exists = (selector: string): Promise<string> =>
    panel(`String(!!document.querySelector('${selector}'))`)
  const text = (selector: string): Promise<string> =>
    panel(`document.querySelector('${selector}')?.innerText ?? ''`)
  const type = (selector: string, value: string): Promise<string> =>
    panel(`{
      const el = document.querySelector('${selector}')
      el.focus()
      el.value = ${JSON.stringify(value)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      'ok'
    }`)
  const press = (selector: string, key: string, ctrlKey = false): Promise<string> =>
    panel(`{
      const el = document.querySelector('${selector}') ?? document.body
      el.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', ctrlKey: ${ctrlKey}, bubbles: true, cancelable: true }))
      'ok'
    }`)
  const pick = (selector: string, value: string): Promise<string> =>
    panel(`{
      const el = document.querySelector('${selector}')
      el.value = '${value}'
      el.dispatchEvent(new Event('change', { bubbles: true }))
      'ok'
    }`)
  const mark = (): Promise<string> =>
    panel(`document.querySelectorAll('[data-key]').forEach((el) => { el.dataset.old = '1' }); 'ok'`)
  const fresh = (selector: string): Promise<string> => exists(`${selector}:not([data-old])`)
  const fakeState = () => JSON.parse(readFileSync(join(trellisDir, 'state.json'), 'utf8'))

  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(
      win
        .locator('.topbar-right .workspace-chips')
        .getByRole('button', { name: /^Trellis cards: 4/ }),
    ).toBeVisible({ timeout: 20_000 })
    await win.keyboard.press(chords.palette)
    await win.locator('[data-slot="command-input"]').fill('Trellis: Open Board')
    await waitForPaletteSelection(win, 'Trellis: Open Board')
    await win.keyboard.press('Enter')
    await expect.poll(() => exists('[data-ref="DEMO-3"]'), { timeout: 20_000 }).toBe('true')

    await panel(`{
      const el = document.querySelector('[data-key="card-filter"]')
      el.focus()
      el.value = 'Rename'
      el.setSelectionRange(2, 4)
      el.dataset.before = 'yes'
      el.dispatchEvent(new Event('input', { bubbles: true }))
      'ok'
    }`)
    expect(
      await panel(`{
        const el = document.activeElement
        JSON.stringify([el.dataset.key, el.dataset.before ?? null, el.value, el.selectionStart, el.selectionEnd])
      }`),
    ).toBe(JSON.stringify(['card-filter', null, 'Rename', 2, 4]))
    expect(
      await panel(`[...document.querySelectorAll('[data-ref]')].map((e) => e.dataset.ref).join()`),
    ).toBe('DEMO-5')
    await type('[data-key="card-filter"]', '')
    await expect.poll(() => exists('[data-ref="DEMO-1"]')).toBe('true')

    await win.locator('#right-panel').getByRole('button', { name: 'New card' }).click()
    await expect.poll(() => exists('form.new-card')).toBe('true')
    expect(await panel(`document.activeElement?.dataset.key ?? ''`)).toBe('new-title')
    await type('[data-key="new-title"]', 'Draft that is dropped')
    await press('[data-key="new-title"]', 'Escape')
    await expect.poll(() => exists('form.new-card')).toBe('false')
    expect(fakeState().board.columns[0].cards.map((c: { ref: string }) => c.ref)).toEqual([
      'DEMO-5',
      'DEMO-3',
    ])
    await win.locator('#right-panel').getByRole('button', { name: 'New card' }).click()
    await expect
      .poll(() => panel(`document.querySelector('[data-key="new-title"]')?.value ?? 'x'`))
      .toBe('')
    await type('[data-key="new-title"]', 'Add a health check')
    await type('[data-key="new-body"]', 'For the load balancer')
    await press('[data-key="new-body"]', 'Enter', true)
    await expect.poll(() => text('.detail-title'), { timeout: 15_000 }).toBe('Add a health check')
    expect(await exists('form.new-card')).toBe('false')
    expect(await text('[data-column="backlog"]')).toContain('Add a health check')

    await click('[data-ref="DEMO-5"]')
    await expect
      .poll(() => text('.detail-title'), { timeout: 15_000 })
      .toBe('Rename the config keys')
    await pick('[data-key="move"]', 'in-progress')
    await mark()
    await expect
      .poll(() => exists('[data-column="in-progress"] [data-ref="DEMO-5"]'), { timeout: 15_000 })
      .toBe('true')
    expect(await exists('[data-column="backlog"] [data-ref="DEMO-5"]')).toBe('false')

    await expect.poll(() => fresh('[data-key="claim-claim"]'), { timeout: 15_000 }).toBe('true')
    await click('[data-key="claim-claim"]')
    await mark()
    await expect.poll(() => fresh('[data-key="claim-release"]'), { timeout: 15_000 }).toBe('true')
    expect(await text('.claim-row')).toContain('Claimed by you')
    const claimed = fakeState().board.columns[1].cards.find(
      (c: { ref: string }) => c.ref === 'DEMO-5',
    )
    expect(claimed.claimed_by).toBe('human:ostia')
    await click('[data-key="claim-renew"]')
    await mark()
    await expect
      .poll(() => readFileSync(join(trellisDir, 'calls.log'), 'utf8'), { timeout: 15_000 })
      .toContain('card renew DEMO-5 --json\n')
    await expect.poll(() => fresh('[data-key="claim-release"]'), { timeout: 15_000 }).toBe('true')
    await click('[data-key="claim-release"]')
    await expect.poll(() => fresh('[data-key="claim-claim"]'), { timeout: 15_000 }).toBe('true')
    expect(
      fakeState().board.columns[1].cards.find((c: { ref: string }) => c.ref === 'DEMO-5')
        .claimed_by,
    ).toBeUndefined()

    await type('[data-key="comment"]', 'Looks right to me')
    await press('[data-key="comment"]', 'Enter', true)
    await expect
      .poll(() => fakeState().comments['DEMO-5']?.map((c: { body: string }) => c.body) ?? [], {
        timeout: 15_000,
      })
      .toEqual(['Looks right to me'])
    await expect.poll(() => panel(`document.querySelector('[data-key="comment"]').value`)).toBe('')

    await click('[data-ref="DEMO-3"]')
    await expect
      .poll(() => text('.detail-title'), { timeout: 15_000 })
      .toBe('Write the rollback runbook')
    await click('[data-key="work"]')
    await expect.poll(() => exists('.work-menu')).toBe('true')
    await press('body', 'Escape')
    await expect.poll(() => exists('.work-menu')).toBe('false')
    expect(await exists('.detail')).toBe('true')
    await press('body', 'Escape')
    await expect.poll(() => exists('.detail')).toBe('false')
    expect(await panel(`document.activeElement?.dataset.key ?? ''`)).toBe('card-DEMO-3')

    await win.locator('#right-panel').getByRole('tab', { name: 'Vault' }).click()
    await expect
      .poll(() => exists('[data-slug="database-concurrency"]'), { timeout: 15_000 })
      .toBe('true')
    await type('[data-key="entry-filter"]', 'rollback')
    await expect.poll(() => exists('[data-slug="database-concurrency"]')).toBe('false')
    expect(await panel(`document.activeElement?.dataset.key ?? ''`)).toBe('entry-filter')
    await click('[data-slug="ops/deploy/rollback-a-deploy"]')
    await expect
      .poll(() => text('.entry-detail .detail-title'), { timeout: 15_000 })
      .toBe('Rollback a deploy')
    await click('[data-key="entry-close"]')
    await expect.poll(() => exists('.entry-detail')).toBe('false')
    expect(await panel(`document.activeElement?.dataset.key ?? ''`)).toBe(
      'entry-ops/deploy/rollback-a-deploy',
    )
  } finally {
    await app.close()
  }
})
