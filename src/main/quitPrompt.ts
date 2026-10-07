import { type MessageBoxOptions, dialog } from 'electron'
import type { RunningGroup } from '../shared/types'

const TEXT = {
  en: {
    title: 'Quit and lose this work?',
    message: 'Quitting ends or discards everything listed here.',
    command: 'Running: {name}',
    agent: 'Agent: {name}',
    unknown: 'a command',
    file: 'Unsaved: {name}',
    scratch: 'Files in the scratch folder: {count}',
    unanswered: 'The window did not answer, so it may have running commands or unsaved files',
    quit: 'Quit',
    cancel: 'Cancel',
  },
  'zh-Hant': {
    title: '要結束並捨棄這些工作嗎？',
    message: '結束後，下列項目會被終止或捨棄。',
    command: '執行中：{name}',
    agent: '代理程式：{name}',
    unknown: '一個指令',
    file: '未儲存：{name}',
    scratch: '暫存資料夾中的檔案：{count}',
    unanswered: '視窗沒有回應，可能仍有執行中的指令或未儲存的檔案',
    quit: '結束',
    cancel: '取消',
  },
} as const

type Text = { [K in keyof (typeof TEXT)['en']]: string }

function quitText(locale: string): Text {
  return /^zh-(Hant|TW|HK|MO)/i.test(locale) ? TEXT['zh-Hant'] : TEXT.en
}

function groupLines(text: Text, group: RunningGroup): string[] {
  const named = (template: string, name: string): string =>
    `  ${template.replace('{name}', name || text.unknown)}`
  return [
    group.workspace,
    ...group.commands.map((c) => named(text.command, c)),
    ...(group.agents ?? []).map((a) => named(text.agent, a)),
    ...group.files.map((f) => named(text.file, f.split('/').pop() || f)),
    ...(group.scratchFiles
      ? [`  ${text.scratch.replace('{count}', String(group.scratchFiles))}`]
      : []),
    ...(group.unanswered ? [`  ${text.unanswered}`] : []),
  ]
}

export function quitPromptOptions(
  groups: readonly RunningGroup[],
  locale: string,
): MessageBoxOptions {
  const text = quitText(locale)
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
  locale: string,
): Promise<boolean> {
  const { response } = await dialog.showMessageBox(quitPromptOptions(groups, locale))
  return response === 1
}
