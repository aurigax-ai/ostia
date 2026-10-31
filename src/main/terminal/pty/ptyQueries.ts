import { hostname } from 'node:os'
import { isHostNamed } from '../../../shared/terminal/osc7'
import type { PaneActivity } from '../../../shared/terminal/ptyApi'
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
  foregroundCwd: (shellPid: number) => Promise<string | null>
}

export type PtyQueries = ReturnType<typeof createPtyQueries>

export function createPtyQueries({
  ptys,
  agentRunning,
  workspaceSandboxes,
  foregroundCwd,
}: PtyQueriesDeps) {
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
    return entry.sandboxed ? workspaceSandboxes.readRules(entry.workspaceId) : null
  }

  function foregroundProgram(paneId: string): string | null {
    const entry = ptys.get(paneId)
    return entry ? paneActivity(entry).program : null
  }

  function reportedCwd(entry: PtyEntry): string | null {
    const report = entry.mirror.cwdReport
    return report && isHostNamed(report.host, hostname()) ? report.path : null
  }

  async function agentCwd(paneId: string): Promise<string | null> {
    const entry = ptys.get(paneId)
    if (!entry) return null
    const shellPid = entry.kept ? await entry.kept.shellPid().catch(() => null) : entry.pty.pid
    const own = shellPid === null ? null : await foregroundCwd(shellPid)
    return own ?? reportedCwd(entry)
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
    return { text, cwd: report?.path ?? null, remote, sandboxed: entry.sandboxed }
  }

  return { paneActivity, foregroundProgram, agentCwd, sandboxReadRules, ptyPid, paneOutput }
}
