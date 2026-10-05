import { Menu, type MenuItemConstructorOptions } from 'electron'

export const MAC_CLOSE_WINDOW_ACCELERATOR = 'Cmd+Shift+W'

export function macAppMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    { label: 'File', submenu: [{ role: 'close', accelerator: MAC_CLOSE_WINDOW_ACCELERATOR }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}

export function installAppMenu(platform: NodeJS.Platform): void {
  if (platform !== 'darwin') return
  Menu.setApplicationMenu(Menu.buildFromTemplate(macAppMenuTemplate()))
}
