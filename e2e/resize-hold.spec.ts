import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { closeAllWorkspaces, expectHeld, openWorkspace } from './helpers'
import { type ElectronApplication, expect, launchShared, type Page, test } from './test'

let app: ElectronApplication | undefined
let win: Page

test.beforeAll(async () => {
  const dataHome = freshDataHome()
  seedSettings(dataHome, {
    ...DOM_RENDERER_SETTINGS,
    behavior: { ...DOM_RENDERER_SETTINGS.behavior, wheelZoom: true },
  })
  app = await launchShared(isolatedLaunch(dataHome))
  win = await app.firstWindow()
  await win.waitForLoadState('domcontentloaded')
})

test.afterEach(async () => {
  await closeAllWorkspaces(win)
})

test.afterAll(async () => {
  await app?.close()
})

for (const order of ['enter-first', 'resize-first'] as const) {
  test(`output that arrives while a resize is held survives the next resize (${order})`, {
    tag: '@race',
  }, async () => {
    test.setTimeout(60_000)
    await openWorkspace(win)
    const rows = win.locator('.xterm-rows').first()
    const paneId = await win.locator('.pane[data-pane-id]').first().getAttribute('data-pane-id')
    if (!paneId) throw new Error('no pane id')

    await win.evaluate((id) => window.ostia.pty.write(id, 'echo ostia_held_$((40+2))'), paneId)
    await expect(rows).toContainText('ostia_held_$((40+2))', { timeout: 10_000 })

    await win.evaluate(
      async ({ id, order }) => {
        const host = document.querySelector(`.pane[data-pane-id="${id}"] .xterm-host`)
        if (!host) throw new Error('no terminal host')
        const zoomIn = (): void => {
          host.dispatchEvent(
            new WheelEvent('wheel', {
              ctrlKey: true,
              metaKey: true,
              deltaY: -1,
              bubbles: true,
              cancelable: true,
            }),
          )
        }
        const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
        if (order === 'enter-first') {
          window.ostia.pty.write(id, '\r')
          zoomIn()
        } else {
          zoomIn()
          await later(4)
          window.ostia.pty.write(id, '\r')
        }
        await later(8)
        zoomIn()
      },
      { id: paneId, order },
    )

    await expect(rows).toContainText('ostia_held_42', { timeout: 10_000 })
    await win.evaluate((id) => window.ostia.pty.write(id, 'echo ostia_flush_$((1+1))\r'), paneId)
    await expect(rows).toContainText('ostia_flush_2', { timeout: 10_000 })
    await expectHeld(async () => (await rows.innerText()).includes('ostia_held_42'), true, 1_500)
  })
}
