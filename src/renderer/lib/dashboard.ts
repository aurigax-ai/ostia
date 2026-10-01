import type { ApprovalRequest } from '@shared/approvals'
import type { QuestionRequest } from '@shared/questions'
import { findPane } from '../layout/tree'
import type { LayoutNode } from '../layout/types'
import { shortenPath } from './railMeta'

export const DASHBOARD_PATH_CHARS = 44
export const CONTEXT_FOLD_CHARS = 320
export const CONTEXT_FOLD_LINES = 4

export type NeedsYouItem =
  | { kind: 'question'; id: string; at: number; question: QuestionRequest; sent: boolean }
  | { kind: 'approval'; id: string; at: number; approval: ApprovalRequest }

export function needsYouItems(
  questions: readonly QuestionRequest[],
  sent: readonly QuestionRequest[],
  approvals: readonly ApprovalRequest[],
): NeedsYouItem[] {
  const open = new Set(questions.map((q) => q.id))
  const items: NeedsYouItem[] = [
    ...questions.map(
      (question): NeedsYouItem => ({
        kind: 'question',
        id: question.id,
        at: question.at,
        question,
        sent: false,
      }),
    ),
    ...sent
      .filter((q) => !open.has(q.id))
      .map(
        (question): NeedsYouItem => ({
          kind: 'question',
          id: question.id,
          at: question.at,
          question,
          sent: true,
        }),
      ),
    ...approvals.map(
      (approval): NeedsYouItem => ({
        kind: 'approval',
        id: approval.id,
        at: approval.at,
        approval,
      }),
    ),
  ]
  return items.sort((a, b) => a.at - b.at)
}

export function isLongContext(text: string): boolean {
  return text.length > CONTEXT_FOLD_CHARS || text.split('\n').length > CONTEXT_FOLD_LINES
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function agoText(
  elapsedMs: number,
  justNow: string,
  format: Pick<Intl.RelativeTimeFormat, 'format'>,
): string {
  if (elapsedMs < MINUTE) return justNow
  if (elapsedMs < HOUR) return format.format(-Math.floor(elapsedMs / MINUTE), 'minute')
  if (elapsedMs < DAY) return format.format(-Math.floor(elapsedMs / HOUR), 'hour')
  return format.format(-Math.floor(elapsedMs / DAY), 'day')
}

export interface PaneWhere {
  workspaceId: string
  workspace: string
  path: string
  shortPath: string
  pane: string
}

export function paneWhere(
  paneId: string,
  workspaces: readonly {
    id: string
    name: string
    customName?: string
    workDir: string
    projectDir?: string
  }[],
  layouts: Readonly<Record<string, { root: LayoutNode } | undefined>>,
): PaneWhere | null {
  for (const workspace of workspaces) {
    const layout = layouts[workspace.id]
    const pane = layout ? findPane(layout.root, paneId) : null
    if (!pane) continue
    const path = workspace.projectDir ?? workspace.workDir
    return {
      workspaceId: workspace.id,
      workspace: workspace.customName ?? workspace.name,
      path,
      shortPath: shortenPath(path, DASHBOARD_PATH_CHARS),
      pane: pane.title,
    }
  }
  return null
}
