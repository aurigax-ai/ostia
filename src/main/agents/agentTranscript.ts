import { homedir } from 'node:os'
import { ipcMain } from 'electron'
import { type AgentResume, parseAgentResume } from '../../shared/agents/agentResume'
import {
  type AgentSessionInfo,
  claudeSessionInfo,
  codexSessionInfo,
} from '../../shared/agents/agentSessionInfo'
import { readRange, transcriptPath } from './transcriptFiles'

export const TRANSCRIPT_TAIL_BYTES = 512 * 1024
const HEAD_BYTES = 64 * 1024

export function readSessionInfo(resume: AgentResume, home = homedir()): AgentSessionInfo | null {
  const path = transcriptPath(resume, home)
  if (!path) return null
  try {
    if (resume.agent === 'claude') {
      return claudeSessionInfo(readRange(path, true, TRANSCRIPT_TAIL_BYTES))
    }
    const head = readRange(path, false, HEAD_BYTES).slice(0, 1)
    return codexSessionInfo([...head, ...readRange(path, true, TRANSCRIPT_TAIL_BYTES)])
  } catch {
    return null
  }
}

export function codexSessionFolder(resume: AgentResume, home = homedir()): string | null {
  return resume.agent === 'codex' ? (readSessionInfo(resume, home)?.cwd ?? null) : null
}

export function registerAgentTranscriptIpc(): void {
  ipcMain.handle('agent:session-info', (_e, raw: unknown) => {
    const resume = parseAgentResume(raw)
    return resume ? readSessionInfo(resume) : null
  })
}
