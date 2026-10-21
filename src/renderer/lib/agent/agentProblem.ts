import type { AgentReply } from '@aurigax-ai/ostia-extension-sdk/contract/agent'
import { currentDict } from '@/lib/app/useDict'

export function agentProblem(reply: Extract<AgentReply, { ok: false }>): string {
  const d = currentDict().agentPane
  if (reply.error === 'no-model' || reply.error === 'unknown-model') return d.noProvider
  if (reply.error === 'sandboxed') return d.sandboxed
  return reply.message ?? reply.error
}
