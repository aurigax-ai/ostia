export interface Strings {
  confirmTitle: string
  confirmMessage: (packages: string[], manager: string) => string
  confirmDetail: (command: string, reason: string | undefined) => string
  approve: string
  deny: string
  terminalTitle: string
  denied: string
  noPackages: string
  invalidPackages: (names: string[]) => string
  tooManyPackages: (max: number) => string
  unknownManager: (name: string, known: string[]) => string
  managerMissing: (name: string) => string
  noManager: string
  noSudo: string
  onePackageOnly: (manager: string) => string
  notOpened: (reason: string) => string
}

const en: Strings = {
  confirmTitle: 'Install system packages',
  confirmMessage: (packages, manager) =>
    `An agent asks to install ${packages.join(', ')} with ${manager}.`,
  confirmDetail: (command, reason) =>
    `Command:\n${command}\n\nReason: ${reason ?? 'none given'}\n\nIt runs in a new terminal next to the agent, where you can see and answer any password prompt.`,
  approve: 'Approve',
  deny: 'Deny',
  terminalTitle: 'Install packages',
  denied: 'the human denied the install; nothing ran',
  noPackages: 'name at least one package',
  invalidPackages: (names) =>
    `invalid package name: ${names.join(', ')} (letters, digits and @ . _ + : -, starting with a letter or digit)`,
  tooManyPackages: (max) => `at most ${max} packages per request`,
  unknownManager: (name, known) => `unknown manager '${name}' (one of: ${known.join(', ')})`,
  managerMissing: (name) => `${name} is not on PATH`,
  noManager: 'no supported package manager found on PATH; pass --manager',
  noSudo: 'this manager needs root and sudo is not on PATH',
  onePackageOnly: (manager) => `${manager} installs one package per request`,
  notOpened: (reason) => `approved, but the terminal could not be opened (${reason})`,
}

const zhHant: Strings = {
  confirmTitle: '安裝系統套件',
  confirmMessage: (packages, manager) => `代理程式要求以 ${manager} 安裝 ${packages.join('、')}。`,
  confirmDetail: (command, reason) =>
    `指令：\n${command}\n\n原因：${reason ?? '未提供'}\n\n它會在代理程式旁的新終端機中執行，你可以在那裡看到並回應密碼提示。`,
  approve: '核准',
  deny: '拒絕',
  terminalTitle: '安裝套件',
  denied: '使用者拒絕安裝；沒有執行任何指令',
  noPackages: '請至少指定一個套件',
  invalidPackages: (names) =>
    `無效的套件名稱：${names.join('、')}（僅限字母、數字與 @ . _ + : -，且須以字母或數字開頭）`,
  tooManyPackages: (max) => `每次最多 ${max} 個套件`,
  unknownManager: (name, known) => `未知的套件管理器「${name}」（可用：${known.join(', ')}）`,
  managerMissing: (name) => `${name} 不在 PATH 中`,
  noManager: 'PATH 中找不到支援的套件管理器；請使用 --manager 指定',
  noSudo: '這個套件管理器需要 root 權限，但 PATH 中沒有 sudo',
  onePackageOnly: (manager) => `${manager} 每次只能安裝一個套件`,
  notOpened: (reason) => `已核准，但無法開啟終端機（${reason}）`,
}

export function stringsFor(locale: string | undefined): Strings {
  return locale?.startsWith('zh') ? zhHant : en
}
