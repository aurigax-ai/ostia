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
  return locale?.startsWith('zh') ? zhHant : en
}
