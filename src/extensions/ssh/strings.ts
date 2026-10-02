import { localized } from '../../shared/extensionLocales'
import { PRODUCT_NAME } from '../../shared/product'
export const CONNECT_USAGE = 'connect [-J <hop>[,<hop>...]] [-p <port>] <[user@]host>'
export const SHOW_USAGE = 'show <host>'
export const HELPER_INSTALL_USAGE = 'helper-install [-J <hop>[,<hop>...]] [-p <port>] <[user@]host>'
export const HELPER_REMOVE_USAGE = 'helper-remove [-J <hop>[,<hop>...]] [-p <port>] <[user@]host>'
export const REMOVE_HELPER_TITLE = 'SSH: Remove Remote Helper'

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
  humanOnly: string
  helperOff: string
  helperRefused: (host: string) => string
  installTitle: string
  installMessage: (host: string) => string
  installNote: string
  hostLabel: string
  fileLabel: string
  install: string
  dontInstall: string
  removeTitle: string
  removeMessage: (host: string) => string
  removeNote: string
  remove: string
  cancel: string
  removeDenied: string
  helperConnectFailed: (reason: string) => string
  helperTimeout: string
  helperNeeds: (tool: string) => string
  helperInstallFailed: (reason: string) => string
  helperRemoveFailed: string
  helperProtocol: string
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
  humanOnly: 'only the human can do this, from the command palette',
  helperOff: 'the remote helper is turned off in Settings → Extensions → SSH',
  helperRefused: (host) =>
    `you chose not to install the helper on ${host}; run "${REMOVE_HELPER_TITLE}" for that host to be asked again`,
  installTitle: 'Install remote helper',
  installMessage: (host) => `Install ${PRODUCT_NAME}’s helper on ${host}?`,
  installNote: `It is a readable shell script that lists, reads and writes files only inside folders you open on this host. It runs as you, over ssh, while a remote folder is open: never with sudo, and it writes nothing of its own outside ~/.pine. Remove it any time with "${REMOVE_HELPER_TITLE}".`,
  hostLabel: 'Host:',
  fileLabel: 'File:',
  install: 'Install',
  dontInstall: 'Don’t install',
  removeTitle: 'Remove remote helper',
  removeMessage: (host) => `Remove ${PRODUCT_NAME}’s helper from ${host}?`,
  removeNote:
    'It closes the remote folders open on this host and deletes ~/.pine/helper there. You will be asked again before it is installed.',
  remove: 'Remove',
  cancel: 'Cancel',
  removeDenied: 'nothing was removed',
  helperConnectFailed: (reason) =>
    `ssh could not reach the helper: ${reason}. The helper connects without a terminal, so the host must accept a key or an ssh agent`,
  helperTimeout:
    'the host did not answer in time. The helper connects without a terminal, so the host must accept a key or an ssh agent',
  helperNeeds: (tool) => `the host has no ${tool}, which the helper needs`,
  helperInstallFailed: (reason) => `the helper could not be installed (${reason})`,
  helperRemoveFailed: 'the helper could not be removed from the host',
  helperProtocol: 'the host answered with something that is not the helper',
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
  humanOnly: '只有使用者可以從指令面板執行這個動作',
  helperOff: '遠端輔助程式已在「設定 → 擴充功能 → SSH」中關閉',
  helperRefused: (host) =>
    `你選擇不在 ${host} 安裝輔助程式；對該主機執行「${REMOVE_HELPER_TITLE}」後會再次詢問`,
  installTitle: '安裝遠端輔助程式',
  installMessage: (host) => `要在 ${host} 安裝 ${PRODUCT_NAME} 的輔助程式嗎？`,
  installNote: `它是一個可讀的 shell 指令稿，只會在你於這台主機開啟的資料夾內列出、讀取與寫入檔案。遠端資料夾開啟時，它以你的身分透過 ssh 執行：不使用 sudo，也不會在 ~/.pine 之外寫入自己的檔案。隨時可用「${REMOVE_HELPER_TITLE}」移除。`,
  hostLabel: '主機：',
  fileLabel: '檔案：',
  install: '安裝',
  dontInstall: '不要安裝',
  removeTitle: '移除遠端輔助程式',
  removeMessage: (host) => `要從 ${host} 移除 ${PRODUCT_NAME} 的輔助程式嗎？`,
  removeNote:
    '這會關閉這台主機上開啟的遠端資料夾，並刪除主機上的 ~/.pine/helper。下次安裝前會再次詢問。',
  remove: '移除',
  cancel: '取消',
  removeDenied: '沒有移除任何東西',
  helperConnectFailed: (reason) =>
    `ssh 無法連上輔助程式：${reason}。輔助程式連線時沒有終端機，所以主機必須接受金鑰或 ssh agent`,
  helperTimeout: '主機沒有及時回應。輔助程式連線時沒有終端機，所以主機必須接受金鑰或 ssh agent',
  helperNeeds: (tool) => `主機沒有輔助程式需要的 ${tool}`,
  helperInstallFailed: (reason) => `無法安裝輔助程式（${reason}）`,
  helperRemoveFailed: '無法從主機移除輔助程式',
  helperProtocol: '主機回應的內容不是輔助程式',
}

export function stringsFor(locale: string | undefined): Strings {
  return localized({ en, 'zh-Hant': zhHant }, locale)
}
