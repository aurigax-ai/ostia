import { type BrowserWindow, Menu, Tray, nativeImage } from 'electron'

export type CloseAction = 'close' | 'hide'

export interface CloseState {
  quitApproved: boolean
  closeToTray: boolean
  startedHidden: boolean
}

export function closeAction(state: CloseState): CloseAction {
  if (state.quitApproved) return 'close'
  return state.closeToTray || state.startedHidden ? 'hide' : 'close'
}

export function readCloseToTray(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return false
  const workspaces = (settings as { workspaces?: unknown }).workspaces
  if (typeof workspaces !== 'object' || workspaces === null) return false
  return (workspaces as { closeToTray?: unknown }).closeToTray === true
}

const TRAY_LABELS = {
  en: { show: 'Show', quit: 'Quit' },
  'zh-Hant': { show: '顯示', quit: '結束' },
} as const

export function trayLabels(locale: string | undefined): { show: string; quit: string } {
  return locale === 'zh-Hant' ? TRAY_LABELS['zh-Hant'] : TRAY_LABELS.en
}

export interface TrayDeps {
  iconPath: string
  tooltip: string
  locale: () => string | undefined
  windows: () => BrowserWindow[]
  quit: () => void
}

const TRAY_ICON_SIZE = 22

export class AppTray {
  private tray: Tray | null = null

  constructor(private readonly deps: TrayDeps) {}

  get visible(): boolean {
    return this.tray !== null
  }

  hide(win: BrowserWindow): void {
    win.hide()
    this.ensure()
  }

  showWindows(): void {
    for (const win of this.deps.windows()) {
      if (win.isDestroyed()) continue
      win.show()
      win.focus()
    }
    this.remove()
  }

  quit(): void {
    this.showWindows()
    this.deps.quit()
  }

  remove(): void {
    this.tray?.destroy()
    this.tray = null
  }

  private ensure(): void {
    if (this.tray) return
    const icon = nativeImage
      .createFromPath(this.deps.iconPath)
      .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE })
    const tray = new Tray(icon)
    const labels = trayLabels(this.deps.locale())
    tray.setToolTip(this.deps.tooltip)
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: labels.show, click: () => this.showWindows() },
        { type: 'separator' },
        { label: labels.quit, click: () => this.quit() },
      ]),
    )
    tray.on('click', () => this.showWindows())
    this.tray = tray
  }
}
