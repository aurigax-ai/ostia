import type { Capability } from '@aurigax-ai/ostia-extension-sdk/contract/capabilities'
import type { QuestionReply, QuestionState } from '../agents/questions'
import type { ApprovalAnswer, ApprovalState } from './approvals'
import type { AgentGroupPlacement, ReachMode } from './reach'
import type {
  ScriptTokenCreateInput,
  ScriptTokenSaveResult,
  ScriptTokensState,
  ScriptTokenUpdateInput,
  ScriptTokenUsage,
} from './scriptTokens'

interface ScriptTokensApi {
  list: () => Promise<ScriptTokensState>
  create: (input: ScriptTokenCreateInput) => Promise<ScriptTokenSaveResult>
  update: (input: ScriptTokenUpdateInput) => Promise<ScriptTokenSaveResult>
  revoke: (id: string) => Promise<boolean>
  usage: (id: string) => Promise<ScriptTokenUsage | null>
  onChanged: (cb: () => void) => () => void
}

interface ApprovalsApi {
  state: () => Promise<ApprovalState>
  answer: (id: string, answer: ApprovalAnswer) => Promise<boolean>
  revoke: (id: string) => Promise<boolean>
  removeAlways: (cap: Capability) => Promise<boolean>
  setReach: (mode: ReachMode) => Promise<boolean>
  onChange: (cb: (state: ApprovalState) => void) => () => void
  agentGroups: () => Promise<AgentGroupPlacement[]>
  onAgentGroupsChanged: (cb: (placements: AgentGroupPlacement[]) => void) => () => void
}

interface QuestionsApi {
  state: () => Promise<QuestionState>
  answer: (id: string, reply: QuestionReply) => Promise<boolean>
  dismiss: (id: string) => Promise<boolean>
  onChange: (cb: (state: QuestionState) => void) => () => void
}

export interface PermissionsBridge {
  approvals: ApprovalsApi
  questions: QuestionsApi
  scriptTokens: ScriptTokensApi
}
