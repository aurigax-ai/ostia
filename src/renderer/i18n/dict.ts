/**
 * i18n catalogs. Supported locales: English (default) + Traditional Chinese.
 * English region variants (en-US, en-GB, …) and zh variants (zh-TW, zh-HK, …)
 * resolve to the canonical locales below — see `resolveLocale`.
 */
/** Locale id — resolved against the language registry (each language is a plugin). */
export type Locale = string

/** English is the source of truth; every other catalog must match this shape. */
export const en = {
  search: {
    placeholder: 'Search sessions, agents, files… or run a command',
    command: 'Search or run a command',
  },
  rail: {
    sessions: 'Sessions',
    newSession: 'New session',
    files: 'Files',
    noFolder: 'No folder open',
    plugins: 'Plugins',
  },
  plugins: {
    languageServers: 'Language servers',
    running: 'running',
    available: 'installed',
    notInstalled: 'not installed',
    error: 'error',
    empty: 'No plugins',
  },
  inspector: {
    review: 'Review',
    uncommitted: 'Uncommitted changes',
    agent: 'Agent',
    acceptHint: '▸▸ accept edits · shift+tab to cycle · esc to interrupt',
  },
  status: { working: '{n} working', waiting: '{n} waiting', panes: '{n} panes' },
  pane: {
    empty: 'empty pane · press ⌘K to run something',
    splitRight: 'Split right',
    splitDown: 'Split down',
    close: 'Close pane',
    newTerminal: 'New terminal',
  },
  palette: {
    title: 'Command palette',
    placeholder: 'Type a command…',
    empty: 'No matching commands',
  },
  topbar: {
    toggleSidebar: 'Toggle sidebar',
    settings: 'Settings',
    notifications: 'Notifications',
    account: 'Account',
    gitDiff: 'Review changes',
  },
  window: { minimize: 'Minimize', maximize: 'Maximize', restore: 'Restore', close: 'Close' },
  settings: {
    title: 'Settings',
    search: 'Search settings',
    language: 'Language',
    appearance: 'Appearance',
    general: 'General',
    terminal: 'Terminal',
    files: 'Files',
    plugins: 'Plugins',
    languageServers: 'Language servers',
    about: 'About',
    builtin: 'Built-in',
    pluginsDesc: 'Installed plugins and what they contribute — themes, language servers, and more.',
    languageServersDesc:
      'Editor language intelligence. Servers are auto-detected on PATH; install one to enable its language.',
    theme: 'Theme',
    uiFont: 'UI font',
    terminalFont: 'Terminal font',
    editorFont: 'Editor font',
    family: 'Family',
    size: 'Size',
    version: 'Version',
    platform: 'Platform',
    openFile: 'Open settings file',
    showHiddenFiles: 'Show hidden files',
    showHiddenFilesDesc: 'Show dotfiles (names starting with .) in the Files explorer.',
    cursorStyle: 'Cursor style',
    styleBlock: 'Block',
    styleUnderline: 'Underline',
    styleBar: 'Bar',
    cursorBlink: 'Cursor blink',
    cursorBlinkDesc: 'Blink the cursor in terminal panes.',
    appearanceDesc:
      'The theme and the fonts for each surface — UI, terminal, and editor are set independently.',
    generalDesc: 'Behavior toggles. All settings are stored in a JSON file you can edit directly.',
    terminalDesc: 'Cursor and behavior for terminal panes. The terminal font is under Appearance.',
    filesDesc: 'The Files explorer.',
    languageDesc: 'The display language for Pine’s interface.',
    aboutDesc: 'Build and environment information.',
    surfaceNote:
      'The terminal font is live; the editor font applies once the editor surface lands (Phase 5).',
  },
}

export type Dict = typeof en

export const zhHant: Dict = {
  search: {
    placeholder: '搜尋工作階段、代理程式、檔案… 或執行指令',
    command: '搜尋或執行指令',
  },
  rail: {
    sessions: '工作階段',
    newSession: '新增工作階段',
    files: '檔案',
    noFolder: '尚未開啟資料夾',
    plugins: '外掛',
  },
  plugins: {
    languageServers: '語言伺服器',
    running: '執行中',
    available: '已安裝',
    notInstalled: '未安裝',
    error: '錯誤',
    empty: '沒有外掛',
  },
  inspector: {
    review: '程式碼審查',
    uncommitted: '未提交的變更',
    agent: '代理程式',
    acceptHint: '▸▸ 接受編輯 · shift+tab 切換 · esc 中斷',
  },
  status: { working: '{n} 執行中', waiting: '{n} 等待中', panes: '{n} 個面板' },
  pane: {
    empty: '空白面板 · 按 ⌘K 執行指令',
    splitRight: '向右分割',
    splitDown: '向下分割',
    close: '關閉面板',
    newTerminal: '新增終端機',
  },
  palette: {
    title: '指令面板',
    placeholder: '輸入指令…',
    empty: '沒有符合的指令',
  },
  topbar: {
    toggleSidebar: '切換側邊欄',
    settings: '設定',
    notifications: '通知',
    account: '帳號',
    gitDiff: '檢視變更',
  },
  window: { minimize: '最小化', maximize: '最大化', restore: '還原', close: '關閉' },
  settings: {
    title: '設定',
    search: '搜尋設定',
    language: '語言',
    appearance: '外觀',
    general: '一般',
    terminal: '終端機',
    files: '檔案',
    plugins: '外掛',
    languageServers: '語言伺服器',
    about: '關於',
    builtin: '內建',
    pluginsDesc: '已安裝的外掛及其貢獻 — 佈景主題、語言伺服器等。',
    languageServersDesc: '編輯器語言智慧。伺服器會自動從 PATH 偵測；安裝後即可啟用該語言。',
    theme: '佈景主題',
    uiFont: '介面字型',
    terminalFont: '終端機字型',
    editorFont: '編輯器字型',
    family: '字型',
    size: '大小',
    version: '版本',
    platform: '平台',
    openFile: '開啟設定檔',
    showHiddenFiles: '顯示隱藏檔案',
    showHiddenFilesDesc: '在檔案總管中顯示點檔案（以 . 開頭的名稱）。',
    cursorStyle: '游標樣式',
    styleBlock: '方塊',
    styleUnderline: '底線',
    styleBar: '直線',
    cursorBlink: '游標閃爍',
    cursorBlinkDesc: '在終端機面板中閃爍游標。',
    appearanceDesc: '佈景主題與各介面字型 — 介面、終端機與編輯器可個別設定。',
    generalDesc: '行為切換。所有設定都儲存在可直接編輯的 JSON 檔案中。',
    terminalDesc: '終端機面板的游標與行為。終端機字型在「外觀」中設定。',
    filesDesc: '檔案總管。',
    languageDesc: 'Pine 介面的顯示語言。',
    aboutDesc: '組建與環境資訊。',
    surfaceNote: '終端機字型已生效；編輯器字型會在編輯器介面建立後套用（階段 5）。',
  },
}

export const catalogs: Record<Locale, Dict> = { en, 'zh-Hant': zhHant }

/** Map any BCP-47 tag (e.g. 'en-GB', 'zh-TW', 'zh-Hant-HK') to a supported locale. */
export function resolveLocale(tag: string | undefined): Locale {
  if (!tag) return 'en'
  const t = tag.toLowerCase()
  if (t.startsWith('zh')) {
    // Traditional for TW/HK/MO or explicit Hant; everything else zh → still Traditional here,
    // since Simplified isn't a supported locale yet (falls back to our only zh catalog).
    return 'zh-Hant'
  }
  return 'en'
}

/** Replace {key} placeholders. */
export function fmt(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`))
}
