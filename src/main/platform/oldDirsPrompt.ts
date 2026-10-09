import type { MessageBoxOptions } from 'electron'
import { PRODUCT_DISPLAY_NAME } from '../../shared/productDisplay'
import {
  type DirMove,
  type MoveResult,
  OLD_PRODUCT_NAME,
  moveOldDir,
  oldAppRunning,
  previewOldDir,
} from './userDirs'

export type OldDirsOutcome = 'none' | 'moved' | 'later' | 'running' | 'failed'

export interface OldDirsDeps {
  moves: readonly DirMove[]
  ask: (options: MessageBoxOptions) => Promise<number>
  locale: string
  log?: (line: string) => void
}

const OLD_DISPLAY_NAME = 'Pine'

const TEXT = {
  en: {
    title: 'Move your {old} data',
    message: '{old} folders were found. Move their contents to {new} and delete the old folders?',
    folders: 'Folders:',
    replaced: '{new} already has these, so the {old} copies are deleted instead of moved:',
    later: '{new} starts without your {old} data and asks again next time.',
    move: 'Move and delete old folders',
    notNow: 'Not now',
    runningTitle: '{old} is still running',
    running: 'Quit {old}, then start {new} again to move your {old} data.',
    ok: 'OK',
    failedTitle: 'Could not move your {old} data',
    failed: 'Some files were not moved. What is left stays in the old folder: {error}',
  },
  'zh-Hant': {
    title: '移動你的 {old} 資料',
    message: '找到 {old} 的資料夾。要把內容移到 {new} 並刪除舊資料夾嗎？',
    folders: '資料夾：',
    replaced: '{new} 已經有以下項目，所以 {old} 的副本會被刪除而不是移動：',
    later: '{new} 會在沒有 {old} 資料的情況下啟動，下次啟動時再詢問。',
    move: '移動並刪除舊資料夾',
    notNow: '稍後',
    runningTitle: '{old} 仍在執行',
    running: '請先結束 {old}，再重新啟動 {new} 以移動你的 {old} 資料。',
    ok: '確定',
    failedTitle: '無法移動你的 {old} 資料',
    failed: '有些檔案沒有移動，剩下的仍在舊資料夾中：{error}',
  },
} as const

type Text = { [K in keyof (typeof TEXT)['en']]: string }

export function oldDirsText(locale: string): Text {
  const table: Text = /^zh-(Hant|TW|HK|MO)/i.test(locale) ? TEXT['zh-Hant'] : TEXT.en
  return Object.fromEntries(
    Object.entries(table).map(([key, value]) => [
      key,
      value.replaceAll('{old}', OLD_DISPLAY_NAME).replaceAll('{new}', PRODUCT_DISPLAY_NAME),
    ]),
  ) as Text
}

function detail(text: Text, moves: readonly DirMove[], previews: readonly MoveResult[]): string {
  const lines = [text.folders, ...moves.map((move) => `  ${move.from} → ${move.to}`)]
  const replaced = previews.flatMap((preview, i) =>
    preview.replaced.map((entry) => `  ${moves[i]?.from}/${entry}`),
  )
  if (replaced.length > 0) lines.push('', text.replaced, ...replaced)
  lines.push('', text.later)
  return lines.join('\n')
}

export async function offerOldDirsMove(deps: OldDirsDeps): Promise<OldDirsOutcome> {
  if (deps.moves.length === 0) return 'none'
  const text = oldDirsText(deps.locale)
  if (oldAppRunning(deps.moves)) {
    await deps.ask({
      type: 'info',
      title: text.runningTitle,
      message: text.runningTitle,
      detail: text.running,
      buttons: [text.ok],
    })
    return 'running'
  }
  const previews = deps.moves.map(previewOldDir)
  const answer = await deps.ask({
    type: 'question',
    title: text.title,
    message: text.message,
    detail: detail(text, deps.moves, previews),
    buttons: [text.move, text.notNow],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })
  if (answer !== 0) return 'later'
  try {
    for (const move of deps.moves) {
      const result = moveOldDir(move)
      deps.log?.(
        `${OLD_PRODUCT_NAME} folder moved: ${move.from} (${result.moved.length} moved, ${result.replaced.length} replaced)`,
      )
    }
  } catch (err) {
    await deps.ask({
      type: 'error',
      title: text.failedTitle,
      message: text.failedTitle,
      detail: text.failed.replace('{error}', (err as Error).message),
      buttons: [text.ok],
    })
    return 'failed'
  }
  return 'moved'
}
