import type { MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const installed: unknown[] = []
const about: unknown[] = []

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (items: unknown[]) => ({ items }),
    setApplicationMenu: (menu: unknown) => installed.push(menu),
  },
  app: { setAboutPanelOptions: (options: unknown) => about.push(options) },
}))

const {
  MAC_CLOSE_WINDOW_ACCELERATOR,
  MAC_SETTINGS_ACCELERATOR,
  installAppMenu,
  macAppMenuTemplate,
} = await import('./appMenu')

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu as MenuItemConstructorOptions[]) : []),
  ])
}

const openSettings = vi.fn()
const template = () => macAppMenuTemplate({ productName: 'Ostia', openSettings })

describe('macOS application menu', () => {
  beforeEach(() => {
    installed.length = 0
    about.length = 0
    openSettings.mockClear()
  })

  it('leaves Cmd+W to the renderer, where it closes the pane, and closes the window with Cmd+Shift+W', () => {
    const items = flatten(template())
    const accelerators = items.map((item) => item.accelerator).filter(Boolean)
    expect(accelerators).not.toContain('Cmd+W')
    expect(accelerators).not.toContain('CmdOrCtrl+W')
    expect(items.find((item) => item.role === 'close')?.accelerator).toBe(
      MAC_CLOSE_WINDOW_ACCELERATOR,
    )
  })

  it('names the app menu and its About, Hide and Quit items after the product, not the package name', () => {
    const [appMenu] = template()
    expect(appMenu.label).toBe('Ostia')
    const labels = flatten([appMenu]).map((item) => item.label ?? '')
    expect(labels).toContain('About Ostia')
    expect(labels).toContain('Hide Ostia')
    expect(labels).toContain('Quit Ostia')
    expect(labels.join(' ')).not.toMatch(/pine/i)
  })

  it('offers Settings… with Cmd+, in the app menu, shown but left to the renderer so it fires once', () => {
    const settings = flatten(template()).find((item) => item.id === 'settings')
    expect(settings?.label).toBe('Settings…')
    expect(settings?.accelerator).toBe(MAC_SETTINGS_ACCELERATOR)
    expect(settings?.registerAccelerator).toBe(false)
    ;(settings?.click as () => void)()
    expect(openSettings).toHaveBeenCalledTimes(1)
  })

  it('has no Reload or Force Reload, so Cmd+R and Cmd+Shift+R cannot reload the window', () => {
    const items = flatten(template())
    const roles = items.map((item) => item.role)
    expect(roles).not.toContain('reload')
    expect(roles).not.toContain('forceReload')
    expect(roles).not.toContain('viewMenu')
    expect(roles).toContain('togglefullscreen')
    expect(roles).toContain('toggleDevTools')
  })

  it('keeps the standard Edit and Window menus that text fields and the browser pane rely on', () => {
    const roles = template().map((item) => item.role)
    expect(roles).toContain('editMenu')
    expect(roles).toContain('windowMenu')
  })

  it('installs the menu and the About panel name on macOS only', () => {
    installAppMenu('linux', { productName: 'Ostia', openSettings })
    installAppMenu('win32', { productName: 'Ostia', openSettings })
    expect(installed).toEqual([])
    installAppMenu('darwin', { productName: 'Ostia', openSettings })
    expect(installed).toHaveLength(1)
    expect(about).toEqual([{ applicationName: 'Ostia' }])
  })
})
