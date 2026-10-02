import { localized } from '../../shared/extensionLocales'
import { PRODUCT_NAME } from '../../shared/product'
export const CONNECT_USAGE = 'connect [-J <hop>[,<hop>...]] [-p <port>] <[user@]host>'
export const SHOW_USAGE = 'show <host>'

export interface Strings {
  confirmTitle: string
  confirmMessage: (destination: string) => string
  commandLabel: string
  targetLabel: string
  throughLabel: string
  proxyCommand: string
  confirmNote: string
  integrationNote: string
  approve: string
  deny: string
  denied: string
  sshMissing: string
  resolveFailed: (reason: string) => string
  timedOut: string
  sandboxed: string
  notOpened: (reason: string) => string
}

const en: Strings = {
  confirmTitle: 'Open SSH connection',
  confirmMessage: (destination) =>
    `A command in a pane asks to open an SSH connection to ${destination}.`,
  commandLabel: 'Command:',
  targetLabel: 'Target:',
  throughLabel: 'Through:',
  proxyCommand: 'a proxy command from your ssh config',
  confirmNote:
    'It opens in a new terminal beside the caller, where you answer any password or host key prompt.',
  integrationNote: `With -t, ssh also runs ${PRODUCT_NAME}’s shell integration on the host for this session, so commands show as blocks: it writes a private temporary folder, sources it as the shell starts and deletes it at once. Nothing is installed and no file in your home folder there changes.`,
  approve: 'Connect',
  deny: 'Deny',
  denied: 'the human denied the connection; nothing was opened',
  sshMissing: 'ssh is not on PATH; install the OpenSSH client',
  resolveFailed: (reason) => `ssh could not resolve the host: ${reason}`,
  timedOut: 'ssh -G did not answer in time',
  sandboxed:
    'this workspace is sandboxed: your ssh config and the network are closed off here, so ssh is not available',
  notOpened: (reason) => `the terminal could not be opened (${reason})`,
}

const zhHant: Strings = {
  confirmTitle: '開啟 SSH 連線',
  confirmMessage: (destination) => `窗格中的指令要求開啟到 ${destination} 的 SSH 連線。`,
  commandLabel: '指令：',
  targetLabel: '目標：',
  throughLabel: '經由：',
  proxyCommand: '你的 ssh 設定中的代理指令',
  confirmNote: '它會在呼叫者旁的新終端機中開啟，你可以在那裡回應密碼或主機金鑰提示。',
  integrationNote: `ssh 會加上 -t，並在主機上為這次工作階段執行 ${PRODUCT_NAME} 的 shell 整合，讓指令顯示為區塊：它會寫入一個私人暫存資料夾，在 shell 啟動時載入後立即刪除。不會安裝任何東西，也不會改動主機上你家目錄中的任何檔案。`,
  approve: '連線',
  deny: '拒絕',
  denied: '使用者拒絕連線；沒有開啟任何終端機',
  sshMissing: 'PATH 中找不到 ssh；請安裝 OpenSSH 用戶端',
  resolveFailed: (reason) => `ssh 無法解析主機：${reason}`,
  timedOut: 'ssh -G 沒有及時回應',
  sandboxed: '這個工作區在沙箱中：這裡無法讀取你的 ssh 設定，也無法使用網路，所以不能使用 ssh',
  notOpened: (reason) => `無法開啟終端機（${reason}）`,
}

export function stringsFor(locale: string | undefined): Strings {
  return localized({ en, 'zh-Hant': zhHant }, locale)
}
