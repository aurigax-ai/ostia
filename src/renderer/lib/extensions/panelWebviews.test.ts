import { PANEL_TOOLBAR_EVENT } from '@aurigax-ai/ostia-extension-sdk/contract/extensionsBridge'
import { describe, expect, it, vi } from 'vitest'
import { registerPanelWebview, sendPanelToolbarEvent } from './panelWebviews'

function fakeWebview() {
  const listeners = new Map<string, () => void>()
  const executed: string[] = []
  const webview = {
    executeJavaScript: vi.fn((script: string) => {
      executed.push(script)
      return Promise.resolve()
    }),
    focus: vi.fn(),
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
    removeEventListener: (name: string) => listeners.delete(name),
  }
  const fire = (name: string): void => listeners.get(name)?.()
  return { webview: webview as unknown as HTMLElement, executed, fire, listeners }
}

describe('panel toolbar events', () => {
  it('reach a panel whose page has finished loading at once', () => {
    const { webview, executed, fire } = fakeWebview()
    registerPanelWebview('loaded', webview)
    fire('did-stop-loading')
    sendPanelToolbarEvent('loaded', { kind: 'tab', id: 'inbox' })
    expect(executed).toHaveLength(1)
    expect(executed[0]).toContain(PANEL_TOOLBAR_EVENT)
    expect(executed[0]).toContain('"id":"inbox"')
  })

  it('wait for a page that has not loaded yet, so its script is listening, and arrive in order', () => {
    const { webview, executed, fire } = fakeWebview()
    registerPanelWebview('fresh', webview)
    sendPanelToolbarEvent('fresh', { kind: 'tab', id: 'inbox' })
    sendPanelToolbarEvent('fresh', { kind: 'tab', id: 'parked' })
    expect(executed).toHaveLength(0)
    fire('did-stop-loading')
    expect(executed).toHaveLength(2)
    expect(executed[0]).toContain('"id":"inbox"')
    expect(executed[1]).toContain('"id":"parked"')
  })

  it('hold events again while the page reloads', () => {
    const { webview, executed, fire } = fakeWebview()
    registerPanelWebview('reload', webview)
    fire('did-stop-loading')
    fire('did-start-loading')
    sendPanelToolbarEvent('reload', { kind: 'back' })
    expect(executed).toHaveLength(0)
    fire('did-stop-loading')
    expect(executed).toHaveLength(1)
  })

  it('keep an event for a panel that is not mounted yet and give it to the page once it loads', () => {
    sendPanelToolbarEvent('late', { kind: 'tab', id: 'inbox' })
    const { webview, executed, fire } = fakeWebview()
    registerPanelWebview('late', webview)
    expect(executed).toHaveLength(0)
    fire('did-stop-loading')
    expect(executed).toHaveLength(1)
    expect(executed[0]).toContain('"id":"inbox"')
  })

  it('stop listening and forget the panel when it unregisters', () => {
    const { webview, listeners } = fakeWebview()
    const off = registerPanelWebview('gone', webview)
    off()
    expect(listeners.size).toBe(0)
    expect(() => sendPanelToolbarEvent('gone', { kind: 'back' })).not.toThrow()
  })
})
