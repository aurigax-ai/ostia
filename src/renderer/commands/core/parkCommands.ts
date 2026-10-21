import { registerCore } from '@/commands/coreCommand'
import { requestPark } from '@/lib/park/parkTab'
import { resumeParked } from '@/lib/park/resumeParked'

interface ResumeParkedArgs {
  workspaceId: string
  resume: unknown
  title: string
}

export function registerParkCommands(): void {
  registerCore({
    id: 'pane.park',
    category: 'pane',
    local: true,
    run: async (_args, ctx) => {
      if (!ctx.activeWorkspaceId || !ctx.activePaneId) return
      await requestPark(ctx.activeWorkspaceId, ctx.activePaneId)
    },
  })

  registerCore<ResumeParkedArgs, { opened: boolean }>({
    id: 'agent.resumeParked',
    category: 'pane',
    local: true,
    hidden: true,
    run: async ({ workspaceId, resume, title }) => ({
      opened: await resumeParked(workspaceId, resume, typeof title === 'string' ? title : ''),
    }),
  })
}
