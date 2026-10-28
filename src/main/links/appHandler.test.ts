import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getApplicationNameForProtocol: () => '' } }))

const { desktopName, handlerName } = await import('./appHandler')

const linux = (default_: string, entry: string | null) => ({
  platform: 'linux' as const,
  protocolApp: () => 'unused',
  queryDefault: async () => default_,
  readDesktop: async () => entry,
})

describe('desktopName', () => {
  it('reads Name from the Desktop Entry section only', () => {
    const entry =
      '[Desktop Action new]\nName=New window\n[Desktop Entry]\nName[de]=Notizen\nName=Obsidian\n'
    expect(desktopName(entry)).toBe('Obsidian')
    expect(desktopName('[Desktop Entry]\nExec=x\n')).toBeNull()
  })
})

describe('handlerName', () => {
  it('uses the default handler file of a scheme on Linux', async () => {
    expect(
      await handlerName(
        'obsidian://a',
        linux('obsidian.desktop\n', '[Desktop Entry]\nName=Obsidian'),
      ),
    ).toBe('Obsidian')
  })

  it('falls back to the file name when the entry has no name or cannot be read', async () => {
    expect(await handlerName('zed://a', linux('dev.zed.Zed.desktop', null))).toBe('dev.zed.Zed')
  })

  it('answers null when no handler is registered or the answer is not a file name', async () => {
    expect(await handlerName('slack://a', linux('', null))).toBeNull()
    expect(await handlerName('slack://a', linux('../x.desktop', null))).toBeNull()
  })

  it('asks Electron on other systems', async () => {
    const mac = { ...linux('', null), platform: 'darwin' as const, protocolApp: () => 'Obsidian' }
    expect(await handlerName('obsidian://a', mac)).toBe('Obsidian')
    expect(await handlerName('obsidian://a', { ...mac, protocolApp: () => '' })).toBeNull()
  })
})
