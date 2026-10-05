import { Menu, type MenuItemConstructorOptions, app } from 'electron'

export const MAC_CLOSE_WINDOW_ACCELERATOR = 'Cmd+Shift+W'
export const MAC_SETTINGS_ACCELERATOR = 'Cmd+,'

export interface AppMenuDeps {
  productName: string
  openSettings: () => void
}

export function macAppMenuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  const name = deps.productName
  return [
    {
      label: name,
      submenu: [
        { role: 'about', label: `About ${name}` },
        { type: 'separator' },
        {
          id: 'settings',
          label: 'Settings…',
          accelerator: MAC_SETTINGS_ACCELERATOR,
          registerAccelerator: false,
          click: () => deps.openSettings(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${name}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: `Quit ${name}` },
      ],
    },
    { label: 'File', submenu: [{ role: 'close', accelerator: MAC_CLOSE_WINDOW_ACCELERATOR }] },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, { type: 'separator' }, { role: 'toggleDevTools' }],
    },
    { role: 'windowMenu' },
  ]
}

export function installAppMenu(platform: NodeJS.Platform, deps: AppMenuDeps): void {
  if (platform !== 'darwin') return
  app.setAboutPanelOptions({ applicationName: deps.productName })
  Menu.setApplicationMenu(Menu.buildFromTemplate(macAppMenuTemplate(deps)))
}
