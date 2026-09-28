import type { CommandInvokeRequest } from '../../shared/types'
import { commands } from './registry'

export function wireCommandBridge(): void {
  const publish = (): void => window.pine?.commands?.publish?.(commands.describe())
  publish()
  commands.subscribe(publish)

  window.pine?.commands?.onInvoke?.(async (req: CommandInvokeRequest) => {
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
