import { hostname } from 'node:os'
import { isHostNamed } from '../../../shared/terminal/osc7'
import type { PaneActivity } from '../../../shared/types'
import type { AgentRunningPanes } from '../../agents/agentRunning'
import type { SandboxReadRules } from '../../sandbox/visibility'
import type { WorkspaceSandboxes } from '../../sandbox/workspaceSandboxes'
import { atLocalPrompt, busyProgram } from '../localPrompt'
import { HISTORY_LINES } from '../screenMirror'
import type { PaneOutput } from '../terminalPathLinks'
import type { PtyEntry } from './ptyRegistry'

export function holdsLocalPrompt(entry: PtyEntry): boolean {
  return atLocalPrompt({
    foreground: entry.pty.process,
    shell: entry.shell,
    sandboxed: entry.sandboxed,
  })
}

interface PtyQueriesDeps {
  ptys: Map<string, PtyEntry>
  agentRunning: AgentRunningPanes
  workspaceSandboxes: WorkspaceSandboxes
}

export type PtyQueries = ReturnType<typeof createPtyQueries>

export function createPtyQueries({ ptys, agentRunning, workspaceSandboxes }: PtyQueriesDeps) {
  function paneActivity(entry: PtyEntry): PaneActivity {
    let program: string | null = null
    try {
      program = busyProgram({
        foreground: entry.pty.process,
        shell: entry.shell,
        sandboxed: entry.sandboxed,
      })
    } catch {
      program = null
    }
    return { program, agentRunning: agentRunning.has(entry.paneId) }
  }

  function sandboxReadRules(entry: PtyEntry): SandboxReadRules | null {
    if (!entry.sandboxed) return null
    try {
      const { denyRead, allowRead } = workspaceSandboxes.config(entry.workspaceId).filesystem
      return { denyRead, allowRead }
    } catch {
      return { denyRead: ['/'], allowRead: [] }
    }
  }

  function ptyPid(paneId: string): number | undefined {
    return ptys.get(paneId)?.pty.pid
  }

  async function paneOutput(paneId: string): Promise<PaneOutput | null> {
    const entry = ptys.get(paneId)
    if (!entry) return null
    const text = await entry.mirror.screenText(HISTORY_LINES)
    const report = entry.mirror.cwdReport
    const remote = report !== null && !isHostNamed(report.host, hostname())
    return { text, cwd: report?.path ?? null, remote }
  }

  return { paneActivity, sandboxReadRules, ptyPid, paneOutput }
}
