import type { CommandInvokeRequest } from '../../shared/types'
import { commands } from './registry'

export function wireCommandBridge(): void {
  const publish = (): void => window.pine?.commands?.publish?.(commands.describe())
  publish()
  commands.subscribe(publish)

  window.pine?.commands?.onInvoke?.(async (req: CommandInvokeRequest) => {
    if (commands.isLocal(req.id)) {
      return {
        ok: false,
        error: { code: 'unknown-command', message: `unknown command: ${req.id}` },
      } as const
    }
    return commands.execWith(
      {
        activeWorkspaceId: req.target.workspaceId,
        activePaneId: req.target.paneId,
        target: req.target,
      },
      req.id,
      req.args,
    )
  })
}
