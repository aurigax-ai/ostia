import type { QuestionRequest } from '@shared/agents/questions'
import type { ApprovalRequest } from '@shared/permissions/approvals'
import { findPane } from '@/lib/layout/tree'
import type { LayoutNode } from '@/lib/layout/types'
import { shortenPath } from '@/lib/sidebar/railMeta'
import { workspaceTitle } from '@/lib/workspaces/workspaceTitle'

export const WHERE_PATH_CHARS = 44
export const CONTEXT_FOLD_CHARS = 320
const CONTEXT_FOLD_LINES = 4

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
      workspace: workspaceTitle(workspace),
      path,
      shortPath: shortenPath(path, WHERE_PATH_CHARS),
      pane: pane.title,
    }
  }
  return null
}

export function sourceWhere(
  source: { extension: string; workspaceId: string },
  workspaces: readonly {
    id: string
    name: string
    customName?: string
    workDir: string
    projectDir?: string
  }[],
): PaneWhere | null {
  const workspace = workspaces.find((w) => w.id === source.workspaceId)
  if (!workspace) return null
  const path = workspace.projectDir ?? workspace.workDir
  return {
    workspaceId: workspace.id,
    workspace: workspaceTitle(workspace),
    path,
    shortPath: shortenPath(path, WHERE_PATH_CHARS),
    pane: source.extension,
  }
}
