import type { ExtensionResult } from '@aurigax-ai/ostia-extension-sdk'
import type {
  BoardInfo,
  CardDetail,
  CardThread,
  ProjectInfo,
  TrellisBoard,
  VaultEntry,
  VaultEntrySummary,
} from './trellis'

export type View = 'board' | 'vault'

export interface PanelContext {
  actor: string
  workspace: { project: string; board: string | null } | null
  canInit: boolean
  projects: ProjectInfo[]
}

export interface BoardData {
  board: TrellisBoard
  boards: BoardInfo[]
}

export interface CardData {
  card: CardDetail
  thread: CardThread | null
}

export interface CardTask {
  ref: string
  agent: string | null
}

export interface NewCardDraft {
  title: string
  body: string
  column: string
  priority: string
}
export const CARD_REF = /^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*?)-\d+$/

const params = new URLSearchParams(location.search)
const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('missing #root')
export const root: HTMLElement = rootEl

interface PanelState {
  view: View
  ctx: PanelContext | null
  failed: ExtensionResult | null
  project: string | null
  boardSlug: string | null
  boardData: BoardData | null
  boardFailure: ExtensionResult | null
  openRef: string | null
  cardData: CardData | null
  cardFailure: ExtensionResult | null
  cardQuery: string
  commentDraft: string
  newCard: NewCardDraft | null
  entries: VaultEntrySummary[] | null
  vaultFailure: ExtensionResult | null
  entryQuery: string
  openSlug: string | null
  entryData: VaultEntry | null
  entryFailure: ExtensionResult | null
  banner: string | null
  notice: string | null
  tasks: Map<string, CardTask>
  agentNames: string[] | null
  workMenu: string | null
  busy: boolean
  requestSeq: number
}

export const state: PanelState = {
  view: params.get('view') === 'vault' ? 'vault' : 'board',
  ctx: null,
  failed: null,
  project: null,
  boardSlug: null,
  boardData: null,
  boardFailure: null,
  openRef: params.get('card'),
  cardData: null,
  cardFailure: null,
  cardQuery: '',
  commentDraft: '',
  newCard: null,
  entries: null,
  vaultFailure: null,
  entryQuery: '',
  openSlug: null,
  entryData: null,
  entryFailure: null,
  banner: null,
  notice: null,
  tasks: new Map<string, CardTask>(),
  agentNames: null,
  workMenu: null,
  busy: false,
  requestSeq: 0,
}

export const hooks = { render: (): void => {} }
