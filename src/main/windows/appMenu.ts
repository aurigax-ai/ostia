import { app, Menu, type MenuItemConstructorOptions } from 'electron'
import { type AppMenuEntry, type AppMenuSpec, parseAppMenuSpec } from '../../shared/app/appMenu'
import { type Dict, fmt } from '../../shared/app/dict'

export const MAC_CLOSE_WINDOW_ACCELERATOR = 'Cmd+Shift+W'
export const MAC_SETTINGS_ACCELERATOR = 'Cmd+,'
const RELOAD_WINDOW_COMMAND = 'window.reload'

type AppMenuText = Dict['native']['appMenu']

export interface AppMenuDeps {
  productName: string
  text: () => AppMenuText
  openSettings: () => void
  runCommand?: (command: string) => void
  reloadWindow?: () => void
}

function commandItems(
  entries: AppMenuEntry[],
  run: ((command: string) => void) | undefined,
  reload: (() => void) | undefined,
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
          click: () => (entry.command === RELOAD_WINDOW_COMMAND ? reload : run)?.(entry.command),
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
  const text = deps.text()
  const items = (section: keyof AppMenuSpec): MenuItemConstructorOptions[] =>
    spec ? commandItems(spec[section].items, deps.runCommand, deps.reloadWindow) : []
  return [
    {
      label: name,
      submenu: [
        { role: 'about', label: fmt(text.about, { product: name }) },
        { type: 'separator' },
        {
          id: 'settings',
          label: text.settings,
          accelerator: MAC_SETTINGS_ACCELERATOR,
          registerAccelerator: false,
          click: () => deps.openSettings(),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: fmt(text.hide, { product: name }) },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit', label: fmt(text.quit, { product: name }) },
      ],
    },
    {
      label: spec?.file.label ?? text.file,
      submenu: [
        ...withTrailingSeparator(items('file')),
        { role: 'close', accelerator: MAC_CLOSE_WINDOW_ACCELERATOR },
      ],
    },
    { role: 'editMenu' },
    {
      label: spec?.view.label ?? text.view,
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

export function linuxAppMenuTemplate(deps: AppMenuDeps): MenuItemConstructorOptions[] {
  const text = deps.text()
  return [
    {
      label: text.view,
      submenu: [
        {
          id: `command:${RELOAD_WINDOW_COMMAND}`,
          label: text.reloadWindow,
          click: () => deps.reloadWindow?.(),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
  ]
}

export interface AppMenu {
  setSpec: (raw: unknown) => boolean
}

export function installAppMenu(platform: NodeJS.Platform, deps: AppMenuDeps): AppMenu {
  if (platform !== 'darwin') {
    Menu.setApplicationMenu(Menu.buildFromTemplate(linuxAppMenuTemplate(deps)))
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
