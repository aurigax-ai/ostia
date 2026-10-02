import { type BrowserWindow, Menu, Tray, nativeImage } from 'electron'
import type { WindowSummary } from '../shared/types'

export type CloseAction = 'close' | 'hide'

export interface CloseState {
  quitApproved: boolean
  closeToTray: boolean
  startedHidden: boolean
  managerLive: boolean
}

export function closeAction(state: CloseState): CloseAction {
  if (state.quitApproved) return 'close'
  return state.closeToTray || state.startedHidden || state.managerLive ? 'hide' : 'close'
}

export function readCloseToTray(settings: unknown): boolean {
  if (typeof settings !== 'object' || settings === null) return true
  const workspaces = (settings as { workspaces?: unknown }).workspaces
  if (typeof workspaces !== 'object' || workspaces === null) return true
  return (workspaces as { closeToTray?: unknown }).closeToTray !== false
}

export function isHiddenLaunch(argv: readonly string[]): boolean {
  return argv.includes('--hidden')
}

const TRAY_LABELS = {
  en: { show: 'Show', quit: 'Quit', unread: '{count} unread' },
  'zh-Hant': { show: '顯示', quit: '結束', unread: '{count} 則未讀' },
} as const

export function trayLabels(locale: string | undefined): {
  show: string
  quit: string
  unread: string
} {
  return locale === 'zh-Hant' ? TRAY_LABELS['zh-Hant'] : TRAY_LABELS.en
}

export function unreadWorkspaces(list: readonly WindowSummary[]): number {
  let count = 0
  for (const win of list) {
    for (const ws of win.workspaces) if (ws.unreadAt > 0 || ws.state === 'waiting') count++
  }
  return count
}

export function trayTooltip(base: string, unread: number, locale: string | undefined): string {
  if (unread <= 0) return base
  return `${base} · ${trayLabels(locale).unread.replace('{count}', String(unread))}`
}

export interface TrayDeps {
  iconPath: string
  tooltip: string
  locale: () => string | undefined
  windows: () => BrowserWindow[]
  quit: () => void
  setBadgeCount: (count: number) => void
}

const TRAY_ICON_SIZE = 22

export class AppTray {
  private tray: Tray | null = null
  private unread = 0

  constructor(private readonly deps: TrayDeps) {}

  get visible(): boolean {
    return this.tray !== null
  }

  hide(win: BrowserWindow): void {
    win.hide()
    this.ensure()
    win.once('show', () => this.removeWhenAllShown())
  }

  private removeWhenAllShown(): void {
    if (this.deps.windows().every((w) => w.isDestroyed() || w.isVisible())) this.remove()
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

  setUnread(count: number): void {
    if (count === this.unread) return
    this.unread = count
    this.deps.setBadgeCount(count)
    this.tray?.setToolTip(trayTooltip(this.deps.tooltip, count, this.deps.locale()))
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
    tray.setToolTip(trayTooltip(this.deps.tooltip, this.unread, this.deps.locale()))
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
