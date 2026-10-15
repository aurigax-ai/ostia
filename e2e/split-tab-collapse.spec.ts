import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultChord, isMac } from './chords'
import { freshDataHome, isolatedLaunch } from './dataHome'
import { openWorkspace, restartApp, typeLine } from './helpers'
import { type Locator, type Page, _electron as electron, expect, test } from './test'

function segment(win: Page, name: string): Locator {
  return win.locator('.split-tab-segment', { hasText: name })
}

function cell(win: Page, id: string): Locator {
  return win.locator(`.pane-cell[data-cell-id="${id}"]`)
}

function strip(win: Page, id: string): Locator {
  return win.locator(`.pane-strip[data-strip-id="${id}"]`)
}

function segmentById(win: Page, id: string): Locator {
  return win.locator(`.split-tab-segment[data-segment-id="${id}"]`)
}

async function sizes(target: Locator): Promise<[number, number][]> {
  const text = (await target.textContent()) ?? ''
  return [...text.matchAll(/size (\d+) (\d+)/g)].map((m) => [Number(m[1]), Number(m[2])])
}

async function dropOnCellEdge(win: Page, tabId: string, cellId: string): Promise<void> {
  await win.evaluate(
    ({ tabId, cellId }) => {
      const dataTransfer = new DataTransfer()
      dataTransfer.setData('application/x-ostia-pane', tabId)
      const tab = document.querySelector(`.pane-tab[data-tab-id="${tabId}"]`)
      tab?.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
      return new Promise<void>((resolve) =>
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const cell = document.querySelector(`.pane-cell[data-cell-id="${cellId}"]`)
            const box = cell?.getBoundingClientRect()
            const point = box
              ? { clientX: box.right - 8, clientY: box.top + box.height / 2 }
              : { clientX: 0, clientY: 0 }
            const under = document.elementFromPoint(point.clientX, point.clientY)
            for (const type of ['dragover', 'drop']) {
              under?.dispatchEvent(
                new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer, ...point }),
              )
            }
            tab?.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer }))
            resolve()
          }),
        ),
      )
    },
    { tabId, cellId },
  )
}

async function area(target: Locator): Promise<number> {
  const box = await target.boundingBox()
  return box ? box.width * box.height : 0
}

test('collapsed panes of a split tab keep running as strips, expand on focus and survive a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-collapse-'))
  const go = join(dir, 'go')
  const dataHome = freshDataHome()
  const ids: Record<string, string> = {}
  let app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.xterm').first().click()

    const wait = `while [ ! -e ${go} ]; do sleep 0.2; done`
    await typeLine(
      win,
      `ostia process run "${wait}; echo printed-while-collapsed; ostia state done printed" --name w1 --tab workers`,
    )
    await typeLine(win, 'ostia process run "echo w2-ready" --name w2 --tab workers')
    await typeLine(
      win,
      `ostia process run "${wait}; printf '\\033]9;%s\\007' needs-a-look" --name w3 --tab workers`,
    )
    await typeLine(win, 'ostia process run "echo w4-ready" --name w4 --tab workers')
    await expect(win.locator('.split-tab-segment')).toHaveCount(4, { timeout: 30_000 })
    for (const name of ['w1', 'w2', 'w3', 'w4']) {
      ids[name] = (await segment(win, name).getAttribute('data-segment-id')) ?? ''
    }

    await segment(win, 'w4').locator('.split-tab-segment-main').click()
    await expect(cell(win, ids.w4)).toBeVisible()
    const before = { w2: await area(cell(win, ids.w2)), w4: await area(cell(win, ids.w4)) }

    await segment(win, 'w1').getByRole('button', { name: 'Collapse w1' }).click()
    await segment(win, 'w3').locator('.split-tab-segment-main').click()
    await win.keyboard.press(defaultChord('pane.collapse', isMac))

    await expect(win.locator('.pane-strip')).toHaveCount(2)
    await expect(strip(win, ids.w1)).toContainText('w1')
    await expect(strip(win, ids.w3)).toContainText('w3')
    await expect(cell(win, ids.w1)).toHaveCount(0)
    await expect(cell(win, ids.w3)).toHaveCount(0)
    await expect.poll(() => area(cell(win, ids.w2))).toBeGreaterThan(before.w2)
    await expect.poll(() => area(cell(win, ids.w4))).toBeGreaterThan(before.w4)

    writeFileSync(go, '')
    await expect(strip(win, ids.w1)).toHaveAttribute('data-attention', 'done', { timeout: 15_000 })
    await expect(strip(win, ids.w1)).toContainText('Done')
    await expect(strip(win, ids.w3)).toHaveAttribute('data-attention', /.+/, { timeout: 15_000 })

    await strip(win, ids.w1).getByRole('button', { name: 'Expand w1' }).click()
    await expect(strip(win, ids.w1)).toHaveCount(0)
    await expect(cell(win, ids.w1).locator('.xterm-rows')).toContainText('printed-while-collapsed')
    await expect(segment(win, 'w1')).toHaveClass(/focused/)
    await expect(strip(win, ids.w3)).toHaveCount(1)

    await restartApp(app, win)
  } finally {
    await app.close().catch(() => {})
  }

  app = await electron.launch(isolatedLaunch(dataHome))
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await expect(strip(win, ids.w3)).toHaveCount(1, { timeout: 30_000 })
    await expect(win.locator('.pane-strip')).toHaveCount(1)
    await expect(cell(win, ids.w1)).toBeVisible()

    await win
      .locator(`.split-tab-segment[data-segment-id="${ids.w3}"] .split-tab-segment-main`)
      .click()
    await expect(strip(win, ids.w3)).toHaveCount(0)
    await expect(cell(win, ids.w3)).toBeVisible()
  } finally {
    await app.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a collapsed terminal keeps its size, never 0x0, and refits to its cell on expand', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-collapse-size-'))
  const [first, second] = [join(dir, 'first'), join(dir, 'second')]
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.xterm').first().click()

    const size = 'echo size $(stty size)'
    const until = (file: string) => `while [ ! -e ${file} ]; do sleep 0.2; done`
    await typeLine(
      win,
      `ostia process run "${size}; ${until(first)}; ${size}; ostia state done collapsed; ${until(second)}; while :; do ${size}; sleep 0.3; done" --name w1 --tab sizes`,
    )
    await typeLine(win, 'ostia process run "sleep 600" --name w2 --tab sizes')
    await typeLine(win, 'ostia process run "sleep 600" --name w3 --tab sizes')
    await expect(win.locator('.split-tab-segment')).toHaveCount(3, { timeout: 30_000 })
    const w1 = (await segment(win, 'w1').getAttribute('data-segment-id')) ?? ''
    const w2 = (await segment(win, 'w2').getAttribute('data-segment-id')) ?? ''
    await segment(win, 'w1').locator('.split-tab-segment-main').click()
    const rows = cell(win, w1).locator('.xterm-rows')
    await expect.poll(() => sizes(rows).then((s) => s.length)).toBe(1)
    const [before] = await sizes(rows)
    expect(before[0]).toBeGreaterThan(0)
    expect(before[1]).toBeGreaterThan(0)

    await segmentById(win, w1).locator('.pane-tab-collapse').click()
    await segmentById(win, w2).locator('.pane-tab-collapse').click()
    await expect(win.locator('.pane-strip')).toHaveCount(2)
    writeFileSync(first, '')
    await expect(strip(win, w1)).toHaveAttribute('data-attention', 'done', { timeout: 15_000 })

    await strip(win, w1).getByRole('button', { name: 'Expand w1' }).click()
    await expect(strip(win, w1)).toHaveCount(0)
    expect((await sizes(rows))[1]).toEqual(before)

    writeFileSync(second, '')
    await expect
      .poll(async () => (await sizes(rows)).at(-1)?.[1] ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(before[1])
    const after = (await sizes(rows)).at(-1) ?? [0, 0]
    expect(after[0]).toBeGreaterThan(0)
    await expect(rows.locator(':scope > div')).toHaveCount(after[0])
  } finally {
    await app.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a browser and an editor in a split tab survive a collapse and an expand without reloading', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ostia-collapse-surfaces-'))
  const notes = join(dir, 'notes.txt')
  writeFileSync(notes, 'kept-through-collapse\n')
  const app = await electron.launch(isolatedLaunch())
  try {
    const win = await app.firstWindow()
    await win.waitForLoadState('domcontentloaded')
    await openWorkspace(win)
    await win.locator('.xterm').first().click()
    const caller = (await win.locator('.pane-tab').first().getAttribute('data-tab-id')) ?? ''
    await typeLine(win, 'ostia process run "sleep 600" --name w1 --tab mix')
    await typeLine(win, 'ostia process run "sleep 600" --name w2 --tab mix')
    await expect(win.locator('.split-tab-segment')).toHaveCount(2, { timeout: 30_000 })
    const w2 = (await segment(win, 'w2').getAttribute('data-segment-id')) ?? ''

    await typeLine(win, `ostia open ${notes}`)
    await expect(win.locator('.monaco-editor')).toHaveCount(1, { timeout: 15_000 })
    await win.getByRole('button', { name: 'New browser tab' }).first().click()
    await expect(win.locator('webview')).toHaveCount(1, { timeout: 15_000 })
    const editor =
      (await win
        .locator('.pane-tab:not(.pane-split-tab)', { hasText: 'notes.txt' })
        .getAttribute('data-tab-id')) ?? ''
    const browser =
      (
        await win
          .locator('.pane-tab:not(.pane-split-tab)')
          .evaluateAll((tabs) => tabs.map((t) => t.getAttribute('data-tab-id') ?? ''))
      ).find((id) => id !== editor && id !== caller) ?? ''

    for (const id of [editor, browser]) {
      await segment(win, 'w2').locator('.split-tab-segment-main').click()
      await dropOnCellEdge(win, id, w2)
    }
    await expect(win.locator('.split-tab-segment')).toHaveCount(4)
    await expect(cell(win, editor)).toBeVisible()
    await expect(cell(win, browser)).toBeVisible()

    await win.evaluate(() => {
      const view = document.querySelector('webview') as HTMLElement & { loads?: number }
      view.dataset.collapseMark = 'kept'
      view.loads = 0
      view.addEventListener('did-start-loading', () => {
        view.loads = (view.loads ?? 0) + 1
      })
      ;(document.querySelector('.monaco-editor') as HTMLElement).dataset.collapseMark = 'kept'
    })

    await segmentById(win, editor).locator('.pane-tab-collapse').click()
    await segmentById(win, browser).locator('.pane-tab-collapse').click()
    await expect(win.locator('.pane-strip')).toHaveCount(2)

    await strip(win, browser).locator('.pane-strip-main').click()
    await strip(win, editor).locator('.pane-strip-main').click()
    await expect(win.locator('.pane-strip')).toHaveCount(0)

    await expect(cell(win, browser).locator('webview[data-collapse-mark="kept"]')).toBeVisible()
    await expect(
      cell(win, editor).locator('.monaco-editor[data-collapse-mark="kept"]'),
    ).toContainText('kept-through-collapse')
    expect(
      await win.evaluate(
        () => (document.querySelector('webview') as HTMLElement & { loads?: number }).loads,
      ),
    ).toBe(0)
  } finally {
    await app.close().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})
