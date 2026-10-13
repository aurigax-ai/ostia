import { describe, expect, it, vi } from 'vitest'

const electron = vi.hoisted(() => ({
  app: { commandLine: { appendSwitch: vi.fn() } },
  protocol: { registerSchemesAsPrivileged: vi.fn() },
}))
vi.mock('electron', () => electron)

import { registerPreviewScheme } from './previewScheme'

describe('registerPreviewScheme', () => {
  it('turns off DNS prefetch for every renderer, the one lookup no session rule can stop', () => {
    registerPreviewScheme()
    expect(electron.app.commandLine.appendSwitch.mock.calls).toEqual([
      ['blink-settings', 'dnsPrefetchingEnabled=false'],
    ])
  })

  it('registers the preview scheme as standard and secure, never as one that bypasses CSP', () => {
    const [[schemes]] = electron.protocol.registerSchemesAsPrivileged.mock.calls as [
      [{ scheme: string; privileges: Record<string, boolean> }[]],
    ]
    expect(schemes).toEqual([
      {
        scheme: 'ostia-preview',
        privileges: expect.objectContaining({
          standard: true,
          secure: true,
          supportFetchAPI: true,
        }),
      },
    ])
    expect(schemes[0].privileges.bypassCSP).toBeUndefined()
    expect(schemes[0].privileges.allowServiceWorkers).toBeUndefined()
  })
})
