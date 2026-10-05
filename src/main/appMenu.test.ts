import type { MenuItemConstructorOptions } from 'electron'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const installed: unknown[] = []

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (items: unknown[]) => ({ items }),
    setApplicationMenu: (menu: unknown) => installed.push(menu),
  },
}))

const { MAC_CLOSE_WINDOW_ACCELERATOR, installAppMenu, macAppMenuTemplate } = await import(
  './appMenu'
)

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu as MenuItemConstructorOptions[]) : []),
  ])
}

describe('macOS application menu', () => {
  beforeEach(() => {
    installed.length = 0
  })

  it('leaves Cmd+W to the renderer, where it closes the pane, and closes the window with Cmd+Shift+W', () => {
    const items = flatten(macAppMenuTemplate())
    const accelerators = items.map((item) => item.accelerator).filter(Boolean)
    expect(accelerators).not.toContain('Cmd+W')
    expect(accelerators).not.toContain('CmdOrCtrl+W')
    expect(items.filter((item) => item.role === 'fileMenu')).toEqual([])
    expect(items.find((item) => item.role === 'close')?.accelerator).toBe(
      MAC_CLOSE_WINDOW_ACCELERATOR,
    )
  })

  it('keeps the standard app, Edit, View and Window menus that text fields and the browser pane rely on', () => {
    const roles = macAppMenuTemplate().map((item) => item.role)
    expect(roles).toEqual(['appMenu', undefined, 'editMenu', 'viewMenu', 'windowMenu'])
  })

  it('installs the menu on macOS only', () => {
    installAppMenu('linux')
    installAppMenu('win32')
    expect(installed).toEqual([])
    installAppMenu('darwin')
    expect(installed).toHaveLength(1)
  })
})
