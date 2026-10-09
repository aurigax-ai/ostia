import type { CommandContext } from '@/commands/registry'
import { focusSurface } from '@/stores/workspaces/surfaceSlotsStore'
import { flushSync } from 'react-dom'

export function focusedPaneId(): string | undefined {
  return document.activeElement?.closest<HTMLElement>('.surface-host')?.dataset.paneId
}

export function callerHasFocus(ctx: Pick<CommandContext, 'origin' | 'activePaneId'>): boolean {
  if (ctx.origin !== 'remote') return true
  return ctx.activePaneId !== null && document.hasFocus() && focusedPaneId() === ctx.activePaneId
}

export function opensQuietly(
  ctx: Pick<CommandContext, 'origin' | 'activePaneId'>,
  background: unknown,
): boolean {
  return background === true || !callerHasFocus(ctx)
}

export function openKeepingFocus<T>(open: () => T): T {
  const focused = focusedPaneId()
  const result = flushSync(open)
  if (focused && focusedPaneId() !== focused) focusSurface(focused)
  return result
}
