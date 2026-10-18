import type { ConfirmRequest } from '@aurigax-ai/ostia-extension-sdk'

const CREATE_CARD_TIMEOUT_MS = 120_000

export interface CreateGateDeps {
  confirm: (req: ConfirmRequest) => Promise<boolean>
  card: (workspaceName: string, locale: string) => ConfirmRequest
  timeoutMs?: number
}

export class CreateGate {
  private readonly always = new Set<string>()

  constructor(private readonly deps: CreateGateDeps) {}

  isAlways(workspaceId: string): boolean {
    return this.always.has(workspaceId)
  }

  revoke(workspaceId: string): void {
    this.always.delete(workspaceId)
  }

  async allows(workspaceId: string, workspaceName: string, locale = 'en'): Promise<boolean> {
    if (this.always.has(workspaceId)) return true
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), this.deps.timeoutMs ?? CREATE_CARD_TIMEOUT_MS)
    })
    const answered = this.deps.confirm(this.deps.card(workspaceName, locale)).catch(() => false)
    const allowed = await Promise.race([answered, timedOut])
    clearTimeout(timer)
    if (allowed) this.always.add(workspaceId)
    return allowed
  }
}
