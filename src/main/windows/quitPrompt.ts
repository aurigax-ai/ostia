import { type MessageBoxOptions, dialog } from 'electron'
import { type Dict, fmt } from '../../shared/app/dict'
import type { RunningGroup } from '../../shared/types'

type Text = Dict['native']['quit']

function groupLines(text: Text, group: RunningGroup): string[] {
  const named = (template: string, name: string): string =>
    `  ${fmt(template, { name: name || text.unknown })}`
  return [
    group.workspace,
    ...group.commands.map((c) => named(text.command, c)),
    ...(group.agents ?? []).map((a) => named(text.agent, a)),
    ...group.files.map((f) => named(text.file, f.split('/').pop() || f)),
    ...(group.scratchFiles ? [`  ${fmt(text.scratch, { count: group.scratchFiles })}`] : []),
    ...(group.unanswered ? [`  ${text.unanswered}`] : []),
  ]
}

export function quitPromptOptions(groups: readonly RunningGroup[], text: Text): MessageBoxOptions {
  return {
    type: 'warning',
    title: text.title,
    message: text.title,
    detail: [text.message, '', ...groups.flatMap((g) => groupLines(text, g))].join('\n'),
    buttons: [text.cancel, text.quit],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  }
}

export async function confirmQuitNatively(
  groups: readonly RunningGroup[],
  text: Text,
): Promise<boolean> {
  const { response } = await dialog.showMessageBox(quitPromptOptions(groups, text))
  return response === 1
}
