import { type MessageBoxOptions, dialog } from 'electron'
import { type Dict, fmt } from '../../shared/app/dict'
import type { QuitAnswer, RunningGroup } from '../../shared/windows/windowsApi'

type Text = Dict['native']['quit']

export const MAX_GROUPS = 3
export const MAX_ITEMS_PER_GROUP = 5
export const MAX_NAME_LENGTH = 40

function clip(name: string): string {
  return name.length > MAX_NAME_LENGTH ? `${name.slice(0, MAX_NAME_LENGTH - 1)}…` : name
}

function capped(lines: string[], max: number, more: (hidden: number) => string): string[] {
  return lines.length > max ? [...lines.slice(0, max), more(lines.length - max)] : lines
}

function groupLines(text: Text, group: RunningGroup): string[] {
  const named = (template: string, name: string): string =>
    `  ${fmt(template, { name: clip(name || text.unknown) })}`
  const items = [
    ...group.commands.map((c) => named(text.command, c)),
    ...(group.agents ?? []).map((a) => named(text.agent, a)),
    ...group.files.map((f) => named(text.file, f.split('/').pop() || f)),
    ...(group.scratchFiles ? [`  ${fmt(text.scratch, { count: group.scratchFiles })}`] : []),
    ...(group.unanswered ? [`  ${text.unanswered}`] : []),
  ]
  return [
    clip(group.workspace),
    ...capped(items, MAX_ITEMS_PER_GROUP, (hidden) => `  ${fmt(text.more, { count: hidden })}`),
  ]
}

export function cappedLostLines(text: Text, groups: readonly RunningGroup[]): string[] {
  const shown = groups.slice(0, MAX_GROUPS).flatMap((g) => groupLines(text, g))
  const hidden = groups.length - MAX_GROUPS
  return hidden > 0 ? [...shown, fmt(text.moreWorkspaces, { count: hidden })] : shown
}

function keptLines(text: Text, keptShells: number): string[] {
  if (keptShells === 0) return []
  const count = keptShells === 1 ? text.keptShellsOne : fmt(text.keptShells, { count: keptShells })
  return [count, text.keptBody]
}

export function quitPromptOptions(
  groups: readonly RunningGroup[],
  keptShells: number,
  text: Text,
): MessageBoxOptions {
  const lost = groups.length > 0 ? [text.message, '', ...cappedLostLines(text, groups)] : []
  const kept = keptLines(text, keptShells)
  const detail = [...lost, ...(lost.length > 0 && kept.length > 0 ? [''] : []), ...kept]
  const offered = keptShells > 0
  return {
    type: 'warning',
    title: offered && groups.length === 0 ? text.keptTitle : text.title,
    message: offered && groups.length === 0 ? text.keptTitle : text.title,
    detail: detail.join('\n'),
    buttons: offered ? [text.cancel, text.end, text.keep] : [text.cancel, text.quit],
    defaultId: offered ? 2 : 0,
    cancelId: 0,
    noLink: true,
  }
}

export function nativeQuitConfirm(
  strings: () => Dict,
): (groups: readonly RunningGroup[], keptShells: number) => Promise<QuitAnswer> {
  return async (groups, keptShells) => {
    const text = strings().native.quit
    const { response } = await dialog.showMessageBox(quitPromptOptions(groups, keptShells, text))
    if (response === 1) return 'quit'
    if (response === 2 && keptShells > 0) return 'keep-shells'
    return 'cancel'
  }
}
