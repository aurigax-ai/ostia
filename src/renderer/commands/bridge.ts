/**
 * Renderer-side half of the command bridge (Slice 6, spec §5.11/§6). Publishes this
 * window's command descriptors to main (so `pine commands` can discover them) and
 * lets main invoke a command here against an explicit target — the counterpart to
 * `execCommand`/`listCommandsFor` in `src/main/index.ts`.
 */
import type { CommandInvokeRequest } from '../../shared/types'
import { commands } from './registry'

/** Wire this window into the main↔renderer command bridge. Call once at startup. */
export function wireCommandBridge(): void {
  // Publish this window's commands so `pine commands` works.
  window.pine?.commands?.publish?.(commands.describe())

  // Let main execute commands here, against the requested target. Built-ins already
  // act on `ctx.activeSessionId`/`ctx.activePaneId`, so passing the target's
  // session/pane as the "active" ones makes explicit targeting work with no
  // built-in changes.
  window.pine?.commands?.onInvoke?.(async (req: CommandInvokeRequest) => {
    return commands.execWith(
      {
        activeSessionId: req.target.sessionId,
        activePaneId: req.target.paneId,
        target: req.target,
      },
      req.id,
      req.args,
    )
  })
}
