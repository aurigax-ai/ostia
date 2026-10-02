import { localized } from '@aurigax-ai/pine-extension-sdk'
import type { KeeperApproval } from './keeper'

export interface Strings {
  sidebar: (n: number) => string
  needsApproval: string
  notifyBody: (n: number, first: KeeperApproval | undefined) => string
  notInstalled: string
  daemonDown: string
  unavailableTitle: string
  noUi: string
  empty: string
}

const describe = (a: KeeperApproval | undefined): string =>
  a ? [a.agent, a.intent].filter(Boolean).join(': ') : ''

const en: Strings = {
  sidebar: (n) => `${n} waiting for approval`,
  needsApproval: 'Keeper needs approval',
  notifyBody: (n, first) => {
    const what = describe(first)
    const head = n === 1 ? '1 query is waiting' : `${n} queries are waiting`
    return what ? `${head} (${what})` : head
  },
  notInstalled:
    'Keeper is not installed or not on PATH. Install it, then run `keeper daemon start` in a terminal.',
  daemonDown:
    'The Keeper daemon is not running. Start it with `keeper daemon start` in a terminal.',
  unavailableTitle: 'Keeper is unavailable',
  noUi: 'The Keeper daemon is running but not serving its dashboard.',
  empty: 'Nothing is waiting for approval.',
}

const zhHant: Strings = {
  sidebar: (n) => `${n} 筆等待核准`,
  needsApproval: 'Keeper 需要核准',
  notifyBody: (n, first) => {
    const what = describe(first)
    const head = `${n} 筆查詢等待核准`
    return what ? `${head}（${what}）` : head
  },
  notInstalled: '尚未安裝 Keeper，或它不在 PATH 中。安裝後請在終端機執行 `keeper daemon start`。',
  daemonDown: 'Keeper 常駐程式沒有執行。請在終端機執行 `keeper daemon start` 啟動。',
  unavailableTitle: 'Keeper 無法使用',
  noUi: 'Keeper 常駐程式正在執行，但沒有提供儀表板。',
  empty: '沒有等待核准的項目。',
}

export function stringsFor(locale: string | undefined): Strings {
  return localized({ en, 'zh-Hant': zhHant }, locale)
}
