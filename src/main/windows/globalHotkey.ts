import { toAccelerator } from '../../shared/keyboard/globalHotkey'

export interface ShortcutRegistry {
  register: (accelerator: string, callback: () => void) => boolean
  unregister: (accelerator: string) => void
}

export type HotkeyStatus = 'off' | 'registered' | 'taken'

export class GlobalHotkey {
  private current: string | null = null

  constructor(
    private readonly registry: ShortcutRegistry,
    private readonly toggle: () => void,
  ) {}

  apply(setting: unknown): HotkeyStatus {
    const next = toAccelerator(setting)
    if (next === this.current) return next ? 'registered' : 'off'
    this.clear()
    if (!next) return 'off'
    if (!this.registry.register(next, this.toggle)) return 'taken'
    this.current = next
    return 'registered'
  }

  clear(): void {
    if (this.current) this.registry.unregister(this.current)
    this.current = null
  }
}

export interface ToggleWindow {
  isVisible: () => boolean
  isFocused: () => boolean
  isDestroyed: () => boolean
}

export function shouldHideWindows(windows: readonly ToggleWindow[]): boolean {
  return windows.some((w) => !w.isDestroyed() && w.isVisible() && w.isFocused())
}

export interface ToggleTray<W extends ToggleWindow> {
  hide: (win: W) => void
}

export function toggleWindows<W extends ToggleWindow>(
  windows: readonly W[],
  tray: ToggleTray<W> | null,
  reveal: () => void,
): void {
  if (!tray || !shouldHideWindows(windows)) {
    reveal()
    return
  }
  for (const win of windows) if (!win.isDestroyed() && win.isVisible()) tray.hide(win)
}
