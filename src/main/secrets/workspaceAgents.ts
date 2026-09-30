import { type SshAgent, startSshAgent } from './sshAgent'

interface Running {
  agent: SshAgent
  keys: string
}

export class WorkspaceAgents {
  private readonly agents = new Map<string, Promise<Running>>()

  async ensure(workspaceId: string, dir: string, keys: readonly string[]): Promise<string | null> {
    if (keys.length === 0) {
      this.stop(workspaceId)
      return null
    }
    const signature = [...keys].sort().join('\n')
    const current = await this.agents.get(workspaceId)?.catch(() => null)
    if (current && current.keys === signature) return current.agent.socket
    this.stop(workspaceId)
    const started = startSshAgent(dir, keys).then((agent) => ({ agent, keys: signature }))
    this.agents.set(workspaceId, started)
    return (await started).agent.socket
  }

  stop(workspaceId: string): void {
    const pending = this.agents.get(workspaceId)
    this.agents.delete(workspaceId)
    void pending?.then((r) => r.agent.stop()).catch(() => undefined)
  }

  stopAll(): void {
    for (const id of [...this.agents.keys()]) this.stop(id)
  }
}
