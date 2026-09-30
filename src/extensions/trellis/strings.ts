import type { CardCounts } from './trellis'

export interface Strings {
  sidebar: (c: CardCounts) => string
  notInstalled: string
  uiFailed: string
  noDir: string
  initTitle: string
  initMessage: (dir: string) => string
  initDetail: string
  initConfirm: string
  cancel: string
  initCancelled: string
  initDone: (key: string, dir: string) => string
  reviewTitle: string
  blockedTitle: string
  unavailableTitle: string
  cardUsage: string
  invalidRef: (raw: string) => string
  cardOpened: (ref: string) => string
}

const en: Strings = {
  sidebar: (c) => (c.claimed > 0 ? `${c.open} open · ${c.claimed} claimed` : `${c.open} open`),
  notInstalled:
    'Trellis is not installed or not on PATH. Install it from https://github.com/mtch3n/trellis and restart the extension.',
  uiFailed: 'The Trellis web UI did not start. Run `trellis doctor` in a terminal to see why.',
  noDir: 'No working directory is known for this pane yet.',
  initTitle: 'Initialize Trellis project',
  initMessage: (dir) => `Run \`trellis init\` in ${dir}?`,
  initDetail:
    'This writes a .trellis marker in that directory and creates a project named after it if none exists.',
  initConfirm: 'Initialize',
  cancel: 'Cancel',
  initCancelled: 'Cancelled; nothing was changed.',
  initDone: (key, dir) =>
    key ? `Trellis project ${key} is set up in ${dir}` : `Trellis is set up in ${dir}`,
  reviewTitle: 'Trellis: ready for your review',
  blockedTitle: 'Trellis: a card is blocked',
  unavailableTitle: 'Trellis is unavailable',
  cardUsage: 'Give a card id, for example: pine trellis card SHOP-12',
  invalidRef: (raw) => `"${raw}" is not a card id like SHOP-12`,
  cardOpened: (ref) => `Opened ${ref}`,
}

const zhHant: Strings = {
  sidebar: (c) =>
    c.claimed > 0 ? `${c.open} 張未完成 · ${c.claimed} 張已認領` : `${c.open} 張未完成`,
  notInstalled:
    '尚未安裝 Trellis，或它不在 PATH 中。請從 https://github.com/mtch3n/trellis 安裝後重新啟動此擴充功能。',
  uiFailed: 'Trellis 網頁介面沒有啟動。請在終端機執行 `trellis doctor` 查看原因。',
  noDir: '尚不知道此窗格的工作目錄。',
  initTitle: '初始化 Trellis 專案',
  initMessage: (dir) => `要在 ${dir} 執行 \`trellis init\` 嗎？`,
  initDetail: '這會在該目錄寫入 .trellis 標記，若尚無專案，會以目錄名稱建立一個。',
  initConfirm: '初始化',
  cancel: '取消',
  initCancelled: '已取消，沒有任何變更。',
  initDone: (key, dir) =>
    key ? `已在 ${dir} 設定 Trellis 專案 ${key}` : `已在 ${dir} 設定 Trellis`,
  reviewTitle: 'Trellis：等待你審閱',
  blockedTitle: 'Trellis：有卡片被阻擋',
  unavailableTitle: 'Trellis 無法使用',
  cardUsage: '請提供卡片編號，例如：pine trellis card SHOP-12',
  invalidRef: (raw) => `「${raw}」不是像 SHOP-12 這樣的卡片編號`,
  cardOpened: (ref) => `已開啟 ${ref}`,
}

export function stringsFor(locale: string | undefined): Strings {
  return locale?.startsWith('zh') ? zhHant : en
}
