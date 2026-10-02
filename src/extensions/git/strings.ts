import { localized } from '../../shared/extensionLocales'
export interface Strings {
  noFile: string
  discardTitle: string
  discardMessage: (count: number) => string
  discardDetail: (paths: string[]) => string
  discardConfirm: string
  cancel: string
  cancelled: string
  nothingToDiscard: string
  emptyMessage: string
  noPaths: string
  uncommitted: string
}

const MAX_LISTED = 12

function listed(paths: string[], more: (n: number) => string): string {
  const shown = paths.slice(0, MAX_LISTED).join('\n')
  return paths.length > MAX_LISTED ? `${shown}\n${more(paths.length - MAX_LISTED)}` : shown
}

const en: Strings = {
  noFile: 'The active pane is not a file. Focus a file view, then run Git: Blame File.',
  discardTitle: 'Discard changes',
  discardMessage: (count) =>
    count === 1
      ? 'Discard the changes to 1 file? This cannot be undone.'
      : `Discard the changes to ${count} files? This cannot be undone.`,
  discardDetail: (paths) =>
    `${listed(paths, (n) => `and ${n} more`)}\n\nModified files go back to their staged or committed content; untracked files are deleted.`,
  discardConfirm: 'Discard',
  cancel: 'Cancel',
  cancelled: 'Cancelled; nothing was changed.',
  nothingToDiscard: 'There are no unstaged or untracked changes to discard.',
  emptyMessage: 'The commit message is empty.',
  noPaths: 'Name at least one path, or pass --all.',
  uncommitted: 'Not committed yet',
}

const zhHant: Strings = {
  noFile: '目前的窗格不是檔案。請先聚焦檔案檢視，再執行「Git：逐行追溯檔案」。',
  discardTitle: '捨棄變更',
  discardMessage: (count) => `要捨棄 ${count} 個檔案的變更嗎？此動作無法復原。`,
  discardDetail: (paths) =>
    `${listed(paths, (n) => `以及另外 ${n} 個`)}\n\n已修改的檔案會回到暫存或已提交的內容；未追蹤的檔案會被刪除。`,
  discardConfirm: '捨棄',
  cancel: '取消',
  cancelled: '已取消，沒有任何變更。',
  nothingToDiscard: '沒有可捨棄的未暫存或未追蹤變更。',
  emptyMessage: '提交訊息是空的。',
  noPaths: '請至少指定一個路徑，或加上 --all。',
  uncommitted: '尚未提交',
}

export function stringsFor(locale: string | undefined): Strings {
  return localized({ en, 'zh-Hant': zhHant }, locale)
}
