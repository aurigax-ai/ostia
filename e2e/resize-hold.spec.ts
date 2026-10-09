import { DOM_RENDERER_SETTINGS, freshDataHome, isolatedLaunch, seedSettings } from './dataHome'
import { openWorkspace } from './helpers'
import { _electron as electron, expect, test } from './test'

for (const order of ['enter-first', 'resize-first'] as const) {
  test(
    `output that arrives while a resize is held survives the next resize (${order})`,
    { tag: '@race' },
    async () => {
      test.setTimeout(60_000)
      const dataHome = freshDataHome()
      seedSettings(dataHome, {
        ...DOM_RENDERER_SETTINGS,
        behavior: { ...DOM_RENDERER_SETTINGS.behavior, wheelZoom: true },
      })
      const app = await electron.launch(isolatedLaunch(dataHome))
      try {
        const win = await app.firstWindow()
        await win.waitForLoadState('domcontentloaded')
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
        await win.waitForTimeout(1_500)
        await expect(rows).toContainText('ostia_held_42')
      } finally {
        await app.close()
      }
    },
  )
}
