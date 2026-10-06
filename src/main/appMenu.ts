import { Menu, type MenuItemConstructorOptions, app } from 'electron'
import { type AppMenuEntry, type AppMenuSpec, parseAppMenuSpec } from '../shared/appMenu'

export const MAC_CLOSE_WINDOW_ACCELERATOR = 'Cmd+Shift+W'
export const MAC_SETTINGS_ACCELERATOR = 'Cmd+,'

export interface AppMenuDeps {
  productName: string
  openSettings: () => void
  runCommand?: (command: string) => void
}

function commandItems(
  entries: AppMenuEntry[],
  run: ((command: string) => void) | undefined,
): MenuItemConstructorOptions[] {
  return entries.map((entry) =>
    'separator' in entry
      ? { type: 'separator' }
      : {
          id: `command:${entry.command}`,
          label: entry.label,
          ...(entry.accelerator
            ? { accelerator: entry.accelerator, registerAccelerator: false }
            : {}),
          click: () => run?.(entry.command),
        },
  )
}

function withTrailingSeparator(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.length > 0 ? [...items, { type: 'separator' }] : items
}

export function macAppMenuTemplate(
  deps: AppMenuDeps,
  spec: AppMenuSpec | null = null,
): MenuItemConstructorOptions[] {
  const name = deps.productName
  const items = (section: keyof AppMenuSpec): MenuItemConstructorOptions[] =>
    spec ? commandItems(spec[section].items, deps.runCommand) : []
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
    {
      label: spec?.file.label ?? 'File',
      submenu: [
        ...withTrailingSeparator(items('file')),
        { role: 'close', accelerator: MAC_CLOSE_WINDOW_ACCELERATOR },
      ],
    },
    { role: 'editMenu' },
    {
      label: spec?.view.label ?? 'View',
      submenu: [
        ...withTrailingSeparator(items('view')),
        { role: 'togglefullscreen' },
        { type: 'separator' },
        { role: 'toggleDevTools' },
      ],
    },
    ...(spec && spec.go.items.length > 0
      ? [{ label: spec.go.label, submenu: items('go') } satisfies MenuItemConstructorOptions]
      : []),
    { role: 'windowMenu' },
    ...(spec && spec.help.items.length > 0
      ? [
          {
            role: 'help',
            label: spec.help.label,
            submenu: items('help'),
          } satisfies MenuItemConstructorOptions,
        ]
      : []),
  ]
}

export function linuxAppMenuTemplate(): MenuItemConstructorOptions[] {
  return [
    {
      label: 'View',
      submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }],
    },
  ]
}

export interface AppMenu {
  setSpec: (raw: unknown) => boolean
}

export function installAppMenu(platform: NodeJS.Platform, deps: AppMenuDeps): AppMenu {
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate(linuxAppMenuTemplate()))
    return { setSpec: () => false }
  }
  app.setAboutPanelOptions({ applicationName: deps.productName })
  Menu.setApplicationMenu(Menu.buildFromTemplate(macAppMenuTemplate(deps)))
  let last = ''
  return {
    setSpec: (raw) => {
      const spec = parseAppMenuSpec(raw)
      if (!spec) return false
      const key = JSON.stringify(spec)
      if (key === last) return true
      last = key
      Menu.setApplicationMenu(Menu.buildFromTemplate(macAppMenuTemplate(deps, spec)))
      return true
    },
  }
}
