import type { AgentResume } from '../../shared/agents/agentResume'

type ResumeListener = (externalPaneId: string, resume: AgentResume) => void

export class AgentResumes {
  private readonly listeners = new Set<ResumeListener>()

  subscribe(listener: ResumeListener): void {
    this.listeners.add(listener)
  }

  emit(externalPaneId: string, resume: AgentResume): void {
    for (const listener of [...this.listeners]) listener(externalPaneId, resume)
  }
}
