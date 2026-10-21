import { dialog, type MessageBoxOptions } from 'electron'
import { type Dict, fmt } from '../../shared/app/dict'
import type { QuitAnswer, RunningGroup } from '../../shared/windows/windowsApi'

type Text = Dict['native']['quit']

export const MAX_GROUPS = 3
export const MAX_ITEMS_PER_GROUP = 5
export const MAX_NAME_COLUMNS = 40

const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x1f1e6, 0x1f1ff],
  [0x2600, 0x27bf],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
]

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

function columns(grapheme: string): number {
  const point = grapheme.codePointAt(0) ?? 0
  return WIDE_RANGES.some(([from, to]) => point >= from && point <= to) ? 2 : 1
}

function clip(name: string): string {
  const flat = name.replace(/\s+/g, ' ').trim()
  const graphemes = Array.from(segmenter.segment(flat), (part) => part.segment)
  if (graphemes.reduce((sum, g) => sum + columns(g), 0) <= MAX_NAME_COLUMNS) return flat
  let used = 1
  let kept = ''
  for (const g of graphemes) {
    used += columns(g)
    if (used > MAX_NAME_COLUMNS) break
    kept += g
  }
  return `${kept}…`
}

function capped(lines: string[], max: number, more: (hidden: number) => string): string[] {
  return lines.length > max + 1 ? [...lines.slice(0, max), more(lines.length - max)] : lines
}

function groupLines(text: Text, group: RunningGroup): string[] {
  const named = (template: string, name: string): string =>
    `  ${fmt(template, { name: clip(name) || text.unknown })}`
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
  if (hidden <= 0) return shown
  return [
    ...shown,
    hidden === 1 ? text.moreWorkspacesOne : fmt(text.moreWorkspaces, { count: hidden }),
  ]
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
